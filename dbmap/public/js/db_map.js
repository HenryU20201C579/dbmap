/* DB Map — frontend del visualizador interactivo.
 *
 * Flujo:
 *  1. Al cargar: fetch /api/method/dbmap.api.get_schema_graph SIN filtros para
 *     poblar la lista de módulos del sidebar. El canvas queda vacío.
 *  2. Click en un módulo: refetch con ?module=X y dibuja el grafo (DocTypes
 *     del módulo + sus vecinos directos a 1 hop).
 *  3. Búsqueda: refetch con ?search=X (también devuelve nodos + vecinos).
 *  4. Click en un nodo del grafo: fetch /api/method/dbmap.api.get_doctype_detail
 *     y rellena el panel lateral derecho.
 *
 * Persistencia: en sessionStorage guardamos el módulo activo y el toggle de
 * child tables — sobrevive a F5 pero no a cierre de pestaña (cada
 * dispositivo arranca limpio si quiere).
 */
(function () {
    "use strict";

    if (typeof cytoscape === "undefined") {
        console.error("[dbmap] Cytoscape no cargó");
        return;
    }
    // Registrar dagre layout si está disponible (CDN). Sin dagre caemos a `cose`,
    // pero con dagre los grafos quedan jerárquicos LR que es lo que un ERD necesita.
    if (window.cytoscapeDagre) {
        try { cytoscape.use(window.cytoscapeDagre); } catch (_) {}
    }

    const $ = (id) => document.getElementById(id);
    const ROOT = document.querySelector(".dbm-root");
    if (!ROOT) return;

    const els = {
        search: $("dbm-search"),
        searchClear: $("dbm-search-clear"),
        searchResults: $("dbm-search-results"),
        toggleAux: $("dbm-toggle-aux"),
        toggleNeighbors: $("dbm-toggle-neighbors"),
        modules: $("dbm-modules"),
        modulesCount: $("dbm-modules-count"),
        crumbs: $("dbm-crumbs"),
        canvas: $("dbm-canvas"),
        empty: $("dbm-empty"),
        loading: $("dbm-loading"),
        legend: $("dbm-legend"),
        stats: $("dbm-stats"),
        fitBtn: $("dbm-fit"),
        relayoutBtn: $("dbm-relayout"),
        exportBtn: $("dbm-export"),
        // Modal flotante (reemplaza el panel lateral .dbm-detail).
        modalBackdrop: $("dbm-modal-backdrop"),
        modal: $("dbm-modal"),
        modalName: $("dbm-modal-name"),
        modalPills: $("dbm-modal-pills"),
        modalClose: $("dbm-modal-close"),
        modalDesk: $("dbm-modal-desk"),
        modalFocus: $("dbm-modal-focus"),
        modalErd: $("dbm-modal-erd"),
        paneForm: $("dbm-pane-form"),
        paneOut: $("dbm-pane-outgoing"),
        paneIn: $("dbm-pane-incoming"),
        tabCountOut: $("dbm-tab-count-out"),
        tabCountIn: $("dbm-tab-count-in"),
    };

    const state = {
        modules: [],
        moduleCounts: {},          // {moduleName: nDoctypesShown}
        moduleTranslations: {},    // {moduleName: spanishName}
        activeModule: null,
        searchTerm: "",
        cy: null,
        currentDoctype: null,
        formStructure: null,
        activeFormTab: 0,
    };

    const SS = {
        MOD: "dbm-active-module",
        AUX: "dbm-include-aux",
        NEI: "dbm-expand-neighbors",
    };

    // GET en vez de POST: endpoint es read-only, evita la dependencia del CSRF
    // (que en bootstrap inicial puede no estar disponible aún).
    async function apiCall(method, params) {
        const qs = new URLSearchParams(params || {}).toString();
        const url = "/api/method/" + method + (qs ? "?" + qs : "");
        const res = await fetch(url, {
            method: "GET",
            headers: { "X-Requested-With": "XMLHttpRequest" },
            credentials: "same-origin",
        });
        if (!res.ok) throw new Error("HTTP " + res.status);
        const j = await res.json();
        return j && j.message;
    }

    // ───── Carga de módulos (poblar sidebar) ─────
    async function bootstrap() {
        showLoading(true);
        try {
            // 1ª llamada: sin filtros → trae todos los módulos + conteo total.
            const data = await apiCall("dbmap.api.get_schema_graph", { include_aux: 0 });
            state.modules = data.modules || [];
            // Conteo + traducción de módulos: lo derivamos del payload completo.
            state.moduleCounts = {};
            state.moduleTranslations = {};
            (data.nodes || []).forEach(n => {
                const m = n.module || "(sin módulo)";
                state.moduleCounts[m] = (state.moduleCounts[m] || 0) + 1;
                if (n.module_es && !state.moduleTranslations[m]) {
                    state.moduleTranslations[m] = n.module_es;
                }
            });
            renderModules();
            els.stats.textContent = `${data.total_doctypes} DocTypes · ${state.modules.length} módulos`;
            // Restaurar selección previa (sessionStorage).
            const lastMod = sessionStorage.getItem(SS.MOD);
            if (lastMod && state.modules.includes(lastMod)) {
                activateModule(lastMod);
            } else {
                showEmpty(true);
            }
            // Restaurar toggles.
            if (sessionStorage.getItem(SS.AUX) === "1") els.toggleAux.checked = true;
            if (sessionStorage.getItem(SS.NEI) === "1") els.toggleNeighbors.checked = true;
        } catch (e) {
            console.error("[dbmap] bootstrap fallo", e);
            els.modules.innerHTML = '<div class="dbm-modules-loading" style="color:var(--dbm-danger)">Error al cargar módulos</div>';
        } finally {
            showLoading(false);
        }
    }

    function renderModules() {
        els.modulesCount.textContent = state.modules.length;
        els.modules.innerHTML = "";
        state.modules.forEach(name => {
            const item = document.createElement("div");
            item.className = "dbm-mod-item";
            item.dataset.module = name;
            const tr = state.moduleTranslations[name];
            const esPart = (tr && tr !== name) ? ` <span class="dbm-mod-es">${escapeHtml(tr)}</span>` : "";
            item.innerHTML = `
                <span class="dbm-mod-name">${escapeHtml(name)}${esPart}</span>
                <span class="dbm-mod-count">${state.moduleCounts[name] || 0}</span>
            `;
            item.addEventListener("click", () => activateModule(name));
            els.modules.appendChild(item);
        });
    }

    function highlightActiveModule() {
        els.modules.querySelectorAll(".dbm-mod-item").forEach(el => {
            el.classList.toggle("is-active", el.dataset.module === state.activeModule);
        });
    }

    // ───── Cargar grafo ─────
    async function activateModule(name) {
        state.activeModule = name;
        state.searchTerm = "";
        els.search.value = "";
        els.searchClear.hidden = true;
        sessionStorage.setItem(SS.MOD, name);
        highlightActiveModule();
        await loadGraph({ module: name });
    }

    async function activateSearch(term) {
        // Mantengo esta función por compatibilidad con bindings antiguos, pero
        // ahora el flujo principal es: search input → dropdown autocomplete →
        // activateDoctype al elegir uno. activateSearch dibuja TODOS los matches
        // (cuando el user presiona Enter sin elegir del dropdown).
        state.searchTerm = term.trim();
        if (!state.searchTerm) {
            if (state.activeModule) activateModule(state.activeModule);
            else showEmpty(true);
            return;
        }
        state.activeModule = null;
        highlightActiveModule();
        hideSearchResults();
        await loadGraph({ search: state.searchTerm });
    }

    async function activateDoctype(name) {
        // Modo focused: dibuja UN doctype + vecinos directos (1-hop forzado).
        state.activeModule = null;
        state.searchTerm = "";
        highlightActiveModule();
        hideSearchResults();
        els.search.value = name;
        els.searchClear.hidden = false;
        await loadGraph({ doctype: name });
    }

    async function loadGraph(filter) {
        showLoading(true);
        showEmpty(false);
        const params = {
            include_aux: els.toggleAux.checked ? 1 : 0,
            expand_neighbors: els.toggleNeighbors.checked ? 1 : 0,
        };
        if (filter.module) params.module = filter.module;
        if (filter.search) params.search = filter.search;
        if (filter.doctype) params.doctype = filter.doctype;

        try {
            const data = await apiCall("dbmap.api.get_schema_graph", params);
            renderGraph(data, filter.doctype || null);
            updateCrumbs(filter, data);
        } catch (e) {
            console.error("[dbmap] loadGraph fallo", e);
            els.crumbs.innerHTML = '<span class="dbm-crumb" style="color:var(--dbm-danger)">Error: ' + escapeHtml(e.message) + '</span>';
        } finally {
            showLoading(false);
        }
    }

    function updateCrumbs(filter, data) {
        const parts = [];
        if (filter.doctype) {
            parts.push(`<span class="dbm-crumb">DocType</span>`);
            parts.push(`<span class="dbm-crumb-sep">/</span>`);
            parts.push(`<span class="dbm-crumb is-active">${escapeHtml(filter.doctype)}</span>`);
            parts.push(`<span class="dbm-crumb-sep">·</span>`);
            parts.push(`<span class="dbm-crumb">+ vecinos directos</span>`);
        } else if (filter.module) {
            parts.push(`<span class="dbm-crumb">Módulo</span>`);
            parts.push(`<span class="dbm-crumb-sep">/</span>`);
            parts.push(`<span class="dbm-crumb is-active">${escapeHtml(filter.module)}</span>`);
        } else if (filter.search) {
            parts.push(`<span class="dbm-crumb">Búsqueda</span>`);
            parts.push(`<span class="dbm-crumb-sep">/</span>`);
            parts.push(`<span class="dbm-crumb is-active">"${escapeHtml(filter.search)}"</span>`);
        }
        parts.push(`<span class="dbm-crumb-sep">·</span>`);
        parts.push(`<span class="dbm-crumb">${data.shown_doctypes} nodos · ${data.edges.length} relaciones</span>`);
        els.crumbs.innerHTML = parts.join("");
    }

    // ───── Autocomplete del buscador ─────
    let _searchAbort = null;
    let _searchActiveIdx = -1;
    async function fetchSearchResults(term) {
        const t = (term || "").trim();
        if (!t || t.length < 1) {
            hideSearchResults();
            return;
        }
        if (_searchAbort) _searchAbort.abort();
        _searchAbort = new AbortController();
        try {
            const data = await apiCall("dbmap.api.list_doctypes", { search: t, limit: 30 });
            renderSearchResults(data, t);
        } catch (e) {
            if (e.name === "AbortError") return;
            console.warn("[dbmap] search fallo", e);
        }
    }
    function renderSearchResults(data, term) {
        els.searchResults.innerHTML = "";
        const items = data.results || [];
        if (!items.length) {
            els.searchResults.innerHTML = `<div class="dbm-sr-empty">Sin resultados para "${escapeHtml(term)}"</div>`;
        } else {
            items.forEach((it, idx) => {
                const div = document.createElement("div");
                div.className = "dbm-sr-item";
                div.setAttribute("role", "option");
                div.dataset.name = it.name;
                const esPart = it.name_es ? ` <span class="dbm-sr-es">${escapeHtml(it.name_es)}</span>` : "";
                div.innerHTML = `
                    <span class="dbm-sr-name">${highlightMatch(it.name, term)}${esPart}</span>
                    <span class="dbm-sr-mod">${escapeHtml(it.module || "—")}</span>
                    <span class="dbm-sr-count" title="campos de relación">${it.linkCount}</span>
                `;
                div.addEventListener("click", () => activateDoctype(it.name));
                els.searchResults.appendChild(div);
            });
            if (data.total > items.length) {
                const more = document.createElement("div");
                more.className = "dbm-sr-more";
                more.textContent = `Mostrando ${items.length} de ${data.total} — refina la búsqueda`;
                els.searchResults.appendChild(more);
            }
        }
        els.searchResults.hidden = false;
        _searchActiveIdx = -1;
    }
    function hideSearchResults() {
        els.searchResults.hidden = true;
        els.searchResults.innerHTML = "";
        _searchActiveIdx = -1;
    }
    function highlightMatch(name, term) {
        const t = (term || "").trim();
        if (!t) return escapeHtml(name);
        const lower = name.toLowerCase();
        const idx = lower.indexOf(t.toLowerCase());
        if (idx < 0) return escapeHtml(name);
        return escapeHtml(name.slice(0, idx))
            + "<b>" + escapeHtml(name.slice(idx, idx + t.length)) + "</b>"
            + escapeHtml(name.slice(idx + t.length));
    }
    function moveSearchSelection(delta) {
        const items = els.searchResults.querySelectorAll(".dbm-sr-item");
        if (!items.length) return;
        _searchActiveIdx = Math.max(0, Math.min(items.length - 1, _searchActiveIdx + delta));
        items.forEach((it, i) => it.classList.toggle("is-active", i === _searchActiveIdx));
        items[_searchActiveIdx].scrollIntoView({ block: "nearest" });
    }
    function commitSearchSelection() {
        const items = els.searchResults.querySelectorAll(".dbm-sr-item");
        const target = _searchActiveIdx >= 0 ? items[_searchActiveIdx] : items[0];
        if (target) activateDoctype(target.dataset.name);
    }

    // ───── Cytoscape (ERD style) ─────
    function buildErdLabel(n) {
        // Construye el label multilínea del nodo ERD:
        //   ┌─ DocType (Traducción) ─┐
        //   │ field1 → Target (Trad)│
        // Cytoscape renderiza con text-wrap:wrap y monospace para alinear.
        const header = n.label_es ? `${n.label} (${n.label_es})` : n.label;
        if (n.placeholder) return header;
        if (!n.fields_summary || !n.fields_summary.length) return header;
        const lines = [header, "─".repeat(Math.max(header.length, 14))];
        n.fields_summary.forEach(f => {
            // Truncar fieldname y target para mantener ancho parejo.
            const fname = (f.fieldname || "").slice(0, 22);
            const targetStr = f.target_es
                ? `→ ${f.target} (${f.target_es})`
                : (f.target ? `→ ${f.target}` : "");
            const target = targetStr.slice(0, 40);
            lines.push(`${fname.padEnd(22, " ")} ${target}`);
        });
        if (n.more_fields > 0) {
            lines.push(`+${n.more_fields} más...`);
        }
        return lines.join("\n");
    }

    function renderGraph(data, focusedId) {
        if (state.cy) {
            try { state.cy.destroy(); } catch (_) {}
            state.cy = null;
        }
        els.legend.hidden = false;

        const cyNodes = (data.nodes || []).map(n => ({
            data: {
                id: n.id,
                label: n.label,
                erdLabel: buildErdLabel(n),
                module: n.module,
                istable: n.istable,
                issingle: n.issingle,
                custom: n.custom,
                placeholder: n.placeholder || 0,
                fieldCount: n.fieldCount,
                linkCount: n.linkCount,
                more: n.more_fields || 0,
            },
            classes: [
                n.istable ? "n-table" : "",
                n.issingle ? "n-single" : "",
                n.custom ? "n-custom" : "",
                n.placeholder ? "n-placeholder" : "",
                (!n.fields_summary || !n.fields_summary.length) ? "n-empty" : "",
                focusedId && n.id === focusedId ? "n-focused" : "",
            ].filter(Boolean).join(" "),
        }));

        const cyEdges = (data.edges || []).map(e => ({
            data: {
                id: e.id,
                source: e.source,
                target: e.target,
                label: e.label,
                fieldname: e.fieldname,
                type: e.type,
                custom: e.custom,
            },
            classes: [
                e.type === "Table" || e.type === "Table MultiSelect" ? "e-table" : "",
                e.type === "Dynamic Link" ? "e-dynamic" : "",
                e.type === "Link" ? "e-link" : "",
                e.custom ? "e-custom" : "",
            ].filter(Boolean).join(" "),
        }));

        state.cy = cytoscape({
            container: els.canvas,
            elements: { nodes: cyNodes, edges: cyEdges },
            wheelSensitivity: 0.2,
            minZoom: 0.15,
            maxZoom: 3,
            style: cyStyles(),
            layout: pickLayout(cyNodes.length),
        });

        // En modo focused: después del layout, centrar zoom 0.9 en el doctype
        // pedido en vez del fit:true que miniaturiza con 90+ nodos.
        if (focusedId) {
            state.cy.ready(() => {
                const focusNode = state.cy.getElementById(focusedId);
                if (focusNode && !focusNode.empty()) {
                    state.cy.zoom(0.9);
                    state.cy.center(focusNode);
                    focusNode.select();
                }
            });
        }

        state.cy.on("tap", "node", (evt) => {
            const id = evt.target.data("id");
            if (id === "*dynamic*") return;
            openDetail(id);
        });
        state.cy.on("tap", (evt) => {
            if (evt.target === state.cy) {
                // click en vacío → cerrar detail
                closeDetail();
            }
        });
        // Hover: resaltar vecinos.
        state.cy.on("mouseover", "node", (evt) => {
            const node = evt.target;
            state.cy.elements().addClass("dim");
            node.removeClass("dim");
            node.neighborhood().removeClass("dim");
        });
        state.cy.on("mouseout", "node", () => {
            state.cy.elements().removeClass("dim");
        });
    }

    function pickLayout(nodeCount) {
        // Si dagre está registrado, usamos layout jerárquico LR (estilo ERD).
        // Si no, fallback a `cose` (force-directed, peor para ERD pero funciona).
        const hasDagre = cytoscape("layout", "dagre");
        if (hasDagre) {
            return {
                name: "dagre",
                rankDir: "LR",         // izquierda → derecha
                nodeSep: 30,           // separación entre nodos del mismo rank
                rankSep: 90,           // separación entre ranks
                edgeSep: 12,
                animate: false,
                fit: true,
                padding: 40,
            };
        }
        return {
            name: "cose",
            animate: false, fit: true, padding: 30,
            nodeRepulsion: () => 80000,
            idealEdgeLength: () => (nodeCount > 40 ? 130 : 90),
            edgeElasticity: () => 32,
            gravity: 0.4, numIter: 1500,
        };
    }

    function cyStyles() {
        return [
            {
                // Nodo ERD: rectángulo grande con label multilínea (header + campos).
                // Monospace para que las "→" se alineen verticalmente.
                selector: "node",
                style: {
                    "background-color": "#14141a",
                    "border-color": "#3a3a48",
                    "border-width": 1.5,
                    "label": "data(erdLabel)",
                    "font-size": 10,
                    "font-family": "Geist Mono, ui-monospace, Menlo, monospace",
                    "color": "#e6e6ed",
                    "text-valign": "center",
                    "text-halign": "center",
                    "text-wrap": "wrap",
                    "text-max-width": "280px",
                    "text-justification": "left",
                    "padding": "12px",
                    "width": "label",
                    "height": "label",
                    "shape": "round-rectangle",
                    "line-height": 1.35,
                    "transition-property": "background-color, border-color, opacity",
                    "transition-duration": "150ms",
                },
            },
            {
                // Nodo sin campos (DocType "hoja"): más compacto, solo el nombre.
                selector: "node.n-empty",
                style: {
                    "font-family": "Geist, sans-serif",
                    "font-size": 12,
                    "padding": "10px",
                    "text-max-width": "160px",
                    "background-color": "#1c1c24",
                },
            },
            {
                selector: "node.n-table",
                style: { "border-color": "#c084fc", "background-color": "#1a141f" },
            },
            {
                selector: "node.n-single",
                style: { "border-style": "dashed" },
            },
            {
                selector: "node.n-custom",
                style: { "border-color": "#fb7185" },
            },
            {
                selector: "node.n-placeholder",
                style: {
                    "background-color": "#1c1c24",
                    "border-color": "#fbbf24",
                    "border-style": "dashed",
                    "color": "#fbbf24",
                    "font-style": "italic",
                    "font-family": "Geist, sans-serif",
                    "font-size": 11,
                },
            },
            {
                selector: "node:selected",
                style: {
                    "border-color": "#6ee7b7",
                    "border-width": 2.5,
                    "background-color": "#1a2520",
                },
            },
            {
                // Nodo focused (el doctype que el user pidió ver puntual).
                // Borde verde grueso y fondo distinto para ubicarlo de un vistazo.
                selector: "node.n-focused",
                style: {
                    "border-color": "#6ee7b7",
                    "border-width": 3,
                    "background-color": "#15251f",
                    "color": "#a7f3d0",
                    "font-size": 11,
                },
            },
            {
                selector: "edge",
                style: {
                    "width": 1.2,
                    "line-color": "#60a5fa",
                    "target-arrow-color": "#60a5fa",
                    "target-arrow-shape": "triangle",
                    "curve-style": "bezier",
                    "arrow-scale": 0.9,
                    "opacity": 0.65,
                    "transition-property": "opacity, line-color, width",
                    "transition-duration": "150ms",
                },
            },
            {
                selector: "edge.e-table",
                style: {
                    "line-color": "#c084fc",
                    "target-arrow-color": "#c084fc",
                    "width": 1.6,
                },
            },
            {
                selector: "edge.e-dynamic",
                style: {
                    "line-color": "#fbbf24",
                    "target-arrow-color": "#fbbf24",
                    "line-style": "dashed",
                },
            },
            {
                selector: "edge.e-custom",
                style: {
                    "line-color": "#fb7185",
                    "target-arrow-color": "#fb7185",
                },
            },
            {
                selector: ".dim",
                style: { "opacity": 0.15 },
            },
        ];
    }

    // ───── Modal de detalle del DocType ─────
    async function openDetail(name) {
        state.currentDoctype = name;
        state.activeFormTab = 0;
        els.modalBackdrop.hidden = false;
        els.modalName.textContent = name;
        els.modalPills.innerHTML = '<span class="dbm-pill dbm-pill-dim">cargando…</span>';
        els.paneForm.innerHTML = '<div style="padding:24px;color:var(--dbm-text-3);font-size:12px;text-align:center">Cargando…</div>';
        els.paneOut.innerHTML = "";
        els.paneIn.innerHTML = "";
        els.tabCountOut.textContent = "0";
        els.tabCountIn.textContent = "0";
        switchTab("form");
        document.body.style.overflow = "hidden";

        try {
            const data = await apiCall("dbmap.api.get_doctype_detail", { name });
            renderDetail(data);
        } catch (e) {
            els.modalPills.innerHTML = `<span class="dbm-pill" style="color:var(--dbm-danger);border-color:var(--dbm-danger)">Error: ${escapeHtml(e.message)}</span>`;
        }
    }

    function renderDetail(data) {
        const dt = data.doctype || {};
        // Header: nombre + traducción al español si existe.
        els.modalName.innerHTML = withEsHtml(dt.name || state.currentDoctype, dt.name_es, "dbm-modal-name-es");

        // Pills de metadata en el header.
        const pills = [];
        if (dt.module) pills.push(`<span class="dbm-pill">${escapeHtml(dt.module)}${dt.module_es ? ` · ${escapeHtml(dt.module_es)}` : ""}</span>`);
        pills.push(`<span class="dbm-pill dbm-pill-mono">${escapeHtml(data.table_name || "—")}</span>`);
        if (data.row_count != null) {
            pills.push(`<span class="dbm-pill">${Number(data.row_count).toLocaleString()} rows</span>`);
        }
        if (dt.istable) pills.push(`<span class="dbm-pill dbm-pill-table">child table</span>`);
        if (dt.issingle) pills.push(`<span class="dbm-pill dbm-pill-warn">single</span>`);
        if (dt.custom) pills.push(`<span class="dbm-pill dbm-pill-custom">custom doctype</span>`);
        if (dt.autoname) pills.push(`<span class="dbm-pill" title="autoname">naming: ${escapeHtml(dt.autoname)}</span>`);
        els.modalPills.innerHTML = pills.join("");

        // Vista formulario (estilo Frappe Desk): tabs/secciones/columnas reales del DocType.
        state.formStructure = buildFormStructure(data.fields || []);
        state.activeFormTab = 0;
        renderFormView();

        // Outgoing (campos Link/Table del DocType).
        const outFields = (data.fields || []).filter(f =>
            ["Link", "Table", "Table MultiSelect", "Dynamic Link"].includes(f.fieldtype)
        );
        els.paneOut.innerHTML = "";
        outFields.forEach(f => els.paneOut.appendChild(renderRelCard(f, "outgoing")));
        els.tabCountOut.textContent = outFields.length;

        // Incoming (otros DocTypes que referencian este).
        els.paneIn.innerHTML = "";
        (data.incoming || []).forEach(inc => els.paneIn.appendChild(renderRelCard(inc, "incoming")));
        els.tabCountIn.textContent = (data.incoming || []).length;

        els.modalDesk.href = `/app/${slugifyDoctype(state.currentDoctype)}`;
    }

    // Parsear DocFields a estructura tabs/sections/columns/fields respetando
    // los Tab Break / Section Break / Column Break del propio DocType.
    function buildFormStructure(fields) {
        const tabs = [{ tabName: "Detalles", sections: [{ title: "", columns: [[]] }] }];
        for (const f of fields) {
            const lastTab = tabs[tabs.length - 1];
            const lastSection = lastTab.sections[lastTab.sections.length - 1];
            const lastCol = lastSection.columns[lastSection.columns.length - 1];

            if (f.fieldtype === "Tab Break") {
                tabs.push({
                    tabName: f.label || f.fieldname || "Tab",
                    sections: [{ title: "", columns: [[]] }],
                });
            } else if (f.fieldtype === "Section Break") {
                lastTab.sections.push({ title: f.label || "", columns: [[]] });
            } else if (f.fieldtype === "Column Break") {
                lastSection.columns.push([]);
            } else {
                lastCol.push(f);
            }
        }
        // Limpiar secciones / columnas vacías.
        for (const t of tabs) {
            t.sections = t.sections.filter(s => s.columns.some(c => c.length > 0));
            for (const s of t.sections) s.columns = s.columns.filter(c => c.length > 0);
        }
        // Si la primera tab quedó vacía pero hay otras, drop.
        if (tabs.length > 1 && !tabs[0].sections.length) tabs.shift();
        return tabs;
    }

    function renderFormView() {
        const tabs = state.formStructure || [];
        if (!tabs.length) {
            els.paneForm.innerHTML = '<div style="padding:24px;color:var(--dbm-text-3);font-size:12px">Este DocType no tiene campos para mostrar.</div>';
            return;
        }
        const activeIdx = Math.min(state.activeFormTab || 0, tabs.length - 1);
        const tabBar = tabs.length > 1
            ? `<div class="dbm-form-tabs">${tabs.map((t, i) =>
                `<button type="button" class="dbm-form-tab ${i === activeIdx ? "is-active" : ""}" data-formtab="${i}">${escapeHtml(t.tabName)}</button>`
            ).join("")}</div>`
            : "";
        const tab = tabs[activeIdx];
        const sectionsHtml = tab.sections.map(renderFormSection).join("");
        els.paneForm.innerHTML = tabBar + `<div class="dbm-form-content">${sectionsHtml}</div>`;
        // Wire clicks de las tabs internas.
        els.paneForm.querySelectorAll(".dbm-form-tab").forEach(btn => {
            btn.addEventListener("click", () => {
                state.activeFormTab = parseInt(btn.dataset.formtab, 10) || 0;
                renderFormView();
            });
        });
        // Wire clicks de los campos Link / Table para navegar.
        els.paneForm.querySelectorAll("[data-navigate]").forEach(el => {
            el.addEventListener("click", () => openDetail(el.dataset.navigate));
        });
    }

    function renderFormSection(s) {
        const colCount = s.columns.length;
        const colsClass = colCount >= 3 ? "cols-3" : colCount === 1 ? "cols-1" : "";
        const cols = s.columns.map(col =>
            `<div class="dbm-form-col">${col.map(renderFormField).join("")}</div>`
        ).join("");
        return `
            <div class="dbm-form-section">
                ${s.title ? `<h3 class="dbm-form-section-title">${escapeHtml(s.title)}</h3>` : ""}
                <div class="dbm-form-cols ${colsClass}">${cols}</div>
            </div>
        `;
    }

    function renderFormField(f) {
        const ft = f.fieldtype || "Data";
        const label = f.label || f.fieldname || "—";
        const labelEs = f.label_es || "";
        const fname = f.fieldname || "";
        const reqd = f.reqd ? `<span class="dbm-form-req">*</span>` : "";
        const help = f.description ? `<div class="dbm-form-help">${escapeHtml(f.description)}</div>` : "";

        // Helper local: label "English (Español)" listo para HTML.
        const labelHtml = withEsHtml(label, labelEs, "dbm-form-label-es");

        // Caso Check: layout horizontal sin label arriba (label inline a la derecha).
        if (ft === "Check") {
            return `
                <div class="dbm-form-field">
                    <div class="dbm-form-check">
                        <span class="dbm-check-box"></span>
                        <span>${labelHtml}</span>
                    </div>
                    ${help}
                </div>`;
        }

        // Caso HTML / Heading: bloque informativo sin input.
        if (ft === "HTML" || ft === "Heading") {
            return `
                <div class="dbm-form-field">
                    <div class="dbm-form-html">${labelHtml} <em>(${escapeHtml(ft)})</em></div>
                </div>`;
        }

        // Resto: label arriba + "input" visual según tipo.
        // Target con traducción al español si aplica.
        const target = (f.options || "").trim();
        const targetEs = f.options_es || "";
        const targetHtml = (lbl) => withEsHtml(target || "—", targetEs, "dbm-form-target-es");

        let body = "";
        if (ft === "Link") {
            body = `<div class="dbm-form-input is-link" data-navigate="${escapeAttr(target)}" title="Click para abrir ${escapeAttr(target)}">→ ${targetHtml()}</div>`;
        } else if (ft === "Table" || ft === "Table MultiSelect") {
            body = `<div class="dbm-form-input is-table" data-navigate="${escapeAttr(target)}" title="Tabla hija — click para abrir ${escapeAttr(target)}">≡ ${targetHtml()} <small style="opacity:.6">(${escapeHtml(ft)})</small></div>`;
        } else if (ft === "Dynamic Link") {
            body = `<div class="dbm-form-input is-dynamic" title="DocType destino determinado por el campo '${escapeAttr(target)}'">→ (dinámico via ${escapeHtml(target || "—")})</div>`;
        } else if (ft === "Select") {
            const opts = (f.options || "").split("\n").filter(Boolean);
            body = `<div class="dbm-form-input is-empty">${opts.length ? escapeHtml(opts[0]) + (opts.length > 1 ? ` <small style="opacity:.5">(+${opts.length - 1} opciones)</small>` : "") : "(sin opciones)"}</div>`;
        } else if (ft === "Long Text" || ft === "Text" || ft === "Small Text" || ft === "Text Editor" || ft === "Code" || ft === "Markdown Editor" || ft === "JSON") {
            body = `<textarea class="dbm-form-input is-empty" disabled rows="3" placeholder="${escapeAttr(ft)}"></textarea>`;
        } else {
            body = `<div class="dbm-form-input is-empty">${escapeHtml(ft)}</div>`;
        }

        return `
            <div class="dbm-form-field">
                <label class="dbm-form-label">
                    <span>${labelHtml}</span>
                    ${reqd}
                    <span class="dbm-form-fname">${escapeHtml(fname)}</span>
                </label>
                ${body}
                ${help}
            </div>
        `;
    }

    function escapeAttr(s) { return escapeHtml(s).replace(/"/g, "&quot;"); }

    // Combina "Label (Traducción)" si hay traducción al español distinta.
    // Devuelve HTML listo para meter en innerHTML.
    function withEsHtml(label, labelEs, esClass) {
        const main = escapeHtml(label || "");
        if (!labelEs || labelEs === label) return main;
        return `${main} <span class="${esClass || "dbm-es"}">(${escapeHtml(labelEs)})</span>`;
    }
    function withEsText(label, labelEs) {
        if (!labelEs || labelEs === label) return label || "";
        return `${label} (${labelEs})`;
    }

    function renderRelCard(rel, kind) {
        const card = document.createElement("div");
        const fieldname = rel.fieldname || "";
        const target = kind === "outgoing" ? rel.options : rel.from_doctype;
        const targetEs = kind === "outgoing" ? (rel.options_es || "") : (rel.from_doctype_es || "");
        const type = rel.fieldtype || rel.type || "Link";
        const isCustom = !!rel.is_custom;
        const typeClass = type.includes("Table") ? "is-table"
            : type === "Dynamic Link" ? "is-dynamic"
            : isCustom ? "is-custom" : "";
        const arrow = kind === "outgoing" ? "→" : "←";
        const navigable = target && target !== "*dynamic*";
        card.className = "dbm-card" + (navigable ? " is-clickable" : "");
        if (navigable) card.title = `Click para abrir ${target}`;
        const metaItems = [];
        if (rel.reqd) metaItems.push("requerido");
        if (rel.is_unique) metaItems.push("único");
        if (isCustom) metaItems.push("custom");
        card.innerHTML = `
            <div class="dbm-card-line1">
                <span class="dbm-card-label">${withEsHtml(rel.label || fieldname, rel.label_es, "dbm-card-label-es")}</span>
                <span class="dbm-card-type ${typeClass}">${escapeHtml(type)}</span>
            </div>
            <div class="dbm-card-line1">
                <span class="dbm-card-arrow">${arrow}</span>
                <span class="dbm-card-target">${withEsHtml(target || "—", targetEs, "dbm-card-target-es")}</span>
            </div>
            <div class="dbm-card-fname">${escapeHtml(fieldname)}</div>
            ${metaItems.length ? `<div class="dbm-card-meta">${metaItems.map(m=>`<span>${m}</span>`).join("")}</div>` : ""}
        `;
        if (navigable) {
            card.addEventListener("click", () => openDetail(target));
        }
        return card;
    }

    function renderFieldCard(f) {
        const card = document.createElement("div");
        card.className = "dbm-card";
        const ft = f.fieldtype || "Data";
        const opts = f.options ? f.options.split("\n")[0] : "";
        const metaItems = [];
        if (f.reqd) metaItems.push("requerido");
        if (f.is_unique) metaItems.push("único");
        if (f.is_custom) metaItems.push("custom");
        card.innerHTML = `
            <div class="dbm-card-line1">
                <span class="dbm-card-label">${withEsHtml(f.label || f.fieldname || "—", f.label_es, "dbm-card-label-es")}</span>
                <span class="dbm-card-type">${escapeHtml(ft)}</span>
            </div>
            ${opts ? `<div class="dbm-card-line1"><span class="dbm-card-arrow">→</span><span class="dbm-card-target">${withEsHtml(opts, f.options_es, "dbm-card-target-es")}</span></div>` : ""}
            <div class="dbm-card-fname">${escapeHtml(f.fieldname || "")}</div>
            ${metaItems.length ? `<div class="dbm-card-meta">${metaItems.map(m=>`<span>${m}</span>`).join("")}</div>` : ""}
        `;
        return card;
    }

    function closeDetail() {
        els.modalBackdrop.hidden = true;
        document.body.style.overflow = "";
        state.currentDoctype = null;
        if (state.cy) state.cy.elements().unselect();
    }

    function switchTab(name) {
        document.querySelectorAll(".dbm-tab").forEach(t => {
            const active = t.dataset.tab === name;
            t.classList.toggle("is-active", active);
            t.setAttribute("aria-selected", active ? "true" : "false");
        });
        document.querySelectorAll(".dbm-modal-pane").forEach(p => {
            p.classList.toggle("is-active", p.dataset.pane === name);
        });
        // Scroll-to-top al cambiar de pestaña.
        const body = document.querySelector(".dbm-modal-body");
        if (body) body.scrollTop = 0;
    }

    function focusOnCurrent() {
        if (!state.cy || !state.currentDoctype) return;
        const n = state.cy.getElementById(state.currentDoctype);
        if (!n || n.empty()) {
            // El doctype no está en el grafo actual → activarlo focused.
            closeDetail();
            activateDoctype(state.currentDoctype);
            return;
        }
        closeDetail();
        n.select();
        state.cy.animate({ center: { eles: n }, zoom: Math.max(state.cy.zoom(), 1.2) }, { duration: 350 });
    }

    function focusErdOnCurrent() {
        // Cierra el modal y dispara activateDoctype para dibujar ERD focused.
        if (!state.currentDoctype) return;
        const name = state.currentDoctype;
        closeDetail();
        activateDoctype(name);
    }

    // ───── Helpers ─────
    function showLoading(on) {
        els.loading.hidden = !on;
        if (on) els.empty.style.display = "none";
        // Al apagar loading: solo restauramos empty si NO hay grafo dibujado.
        else if (!state.cy) els.empty.style.display = "";
    }
    function showEmpty(on) {
        els.empty.style.display = on ? "" : "none";
        els.legend.hidden = on;
    }
    function escapeHtml(s) {
        if (s == null) return "";
        return String(s).replace(/[&<>"']/g, c => ({
            "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
        }[c]));
    }
    function slugifyDoctype(name) {
        return (name || "").toLowerCase().replace(/\s+/g, "-");
    }

    // ───── Bindings ─────
    function bind() {
        let searchTimer = null;
        els.search.addEventListener("input", () => {
            clearTimeout(searchTimer);
            const v = els.search.value;
            els.searchClear.hidden = !v;
            if (!v) { hideSearchResults(); return; }
            searchTimer = setTimeout(() => fetchSearchResults(v), 180);
        });
        els.search.addEventListener("focus", () => {
            if (els.search.value) fetchSearchResults(els.search.value);
        });
        els.search.addEventListener("keydown", (e) => {
            if (els.searchResults.hidden) return;
            if (e.key === "ArrowDown") { e.preventDefault(); moveSearchSelection(1); }
            else if (e.key === "ArrowUp") { e.preventDefault(); moveSearchSelection(-1); }
            else if (e.key === "Enter") { e.preventDefault(); commitSearchSelection(); }
            else if (e.key === "Escape") { e.preventDefault(); hideSearchResults(); }
        });
        document.addEventListener("click", (e) => {
            if (!els.searchResults.hidden && !e.target.closest(".dbm-search-row")) {
                hideSearchResults();
            }
        });
        els.searchClear.addEventListener("click", () => {
            els.search.value = "";
            els.searchClear.hidden = true;
            hideSearchResults();
            // Si había un módulo activo, re-actívalo para volver al estado previo.
            if (state.activeModule) activateModule(state.activeModule);
            else showEmpty(true);
        });
        els.toggleAux.addEventListener("change", () => {
            sessionStorage.setItem(SS.AUX, els.toggleAux.checked ? "1" : "0");
            if (state.activeModule) activateModule(state.activeModule);
            else if (state.searchTerm) activateSearch(state.searchTerm);
        });
        els.toggleNeighbors.addEventListener("change", () => {
            sessionStorage.setItem(SS.NEI, els.toggleNeighbors.checked ? "1" : "0");
            if (state.activeModule) activateModule(state.activeModule);
            else if (state.searchTerm) activateSearch(state.searchTerm);
        });
        els.fitBtn.addEventListener("click", () => state.cy && state.cy.fit(undefined, 30));
        els.relayoutBtn.addEventListener("click", () => {
            if (!state.cy) return;
            state.cy.layout(pickLayout(state.cy.nodes().length)).run();
        });
        els.exportBtn.addEventListener("click", () => {
            if (!state.cy) return;
            const png = state.cy.png({ full: true, scale: 2, bg: "#0c0c10" });
            const a = document.createElement("a");
            a.href = png;
            a.download = `db-map-${state.activeModule || state.searchTerm || "graph"}-${Date.now()}.png`;
            a.click();
        });
        // Modal: cerrar, focus en grafo, ver ERD focused.
        els.modalClose.addEventListener("click", closeDetail);
        els.modalFocus.addEventListener("click", focusOnCurrent);
        els.modalErd.addEventListener("click", focusErdOnCurrent);
        // Click en el backdrop (no en el modal mismo) cierra.
        els.modalBackdrop.addEventListener("click", (e) => {
            if (e.target === els.modalBackdrop) closeDetail();
        });
        // Tabs del modal.
        document.querySelectorAll(".dbm-tab").forEach(t => {
            t.addEventListener("click", () => switchTab(t.dataset.tab));
        });

        document.addEventListener("keydown", (e) => {
            const inField = e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA";
            // Esc cierra modal (siempre, incluso desde input).
            if (e.key === "Escape" && !els.modalBackdrop.hidden) {
                closeDetail();
                return;
            }
            if (inField) return;
            if (e.key === "f" || e.key === "F") {
                if (state.cy) state.cy.fit(undefined, 30);
            }
            if (e.key === "l" || e.key === "L") {
                if (state.cy) state.cy.layout(pickLayout(state.cy.nodes().length)).run();
            }
            if (e.key === "/") {
                e.preventDefault();
                els.search.focus();
                els.search.select();
            }
        });
    }

    bind();
    bootstrap();

    // API global para debug / integraciones externas. Permite, por ejemplo:
    //   window.dbmap.openDoctype('Sales Order')
    //   window.dbmap.activateModule('Selling')
    window.dbmap = {
        get state() { return state; },
        openDoctype: openDetail,
        activateModule,
        activateSearch,
        activateDoctype,
        close: closeDetail,
    };
})();
