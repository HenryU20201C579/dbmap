"""Endpoints para alimentar el visualizador interactivo de relaciones entre
DocTypes. La fuente de verdad es la propia DB del site: leemos `tabDocType` y
`tabDocField` (también `tabCustom Field` para incluir campos custom de cada
empresa) y construimos un grafo de nodos + aristas que el frontend dibuja con
Cytoscape.

Acceso: requiere usuario logueado. No exponemos data sensible — solo metadata
del schema (nombres de tablas, columnas, tipos, módulos).
"""

import json

import frappe


# Tipos de campo que representan una relación entre DocTypes.
_LINK_TYPES = {"Link", "Table", "Table MultiSelect", "Dynamic Link"}


def _require_login():
	if frappe.session.user == "Guest":
		frappe.throw("Login requerido", frappe.PermissionError)


def _fetch_doctypes():
	"""Devuelve dict {name: {module, custom, istable, issingle, description}}.
	Excluye DocTypes virtuales (no tienen tabla SQL detrás)."""
	rows = frappe.db.sql(
		"""
		SELECT name, module, custom, istable, issingle,
			   COALESCE(description, '') AS description
		FROM `tabDocType`
		WHERE COALESCE(is_virtual, 0) = 0
		""",
		as_dict=True,
	)
	return {r["name"]: r for r in rows}


def _fetch_doc_fields():
	"""Todos los DocField estándar + Custom Field, normalizados al mismo shape.
	Devuelve lista de {parent, fieldname, label, fieldtype, options}."""
	standard = frappe.db.sql(
		"""
		SELECT parent, fieldname, label, fieldtype, options
		FROM `tabDocField`
		WHERE fieldtype IN ('Link', 'Table', 'Table MultiSelect', 'Dynamic Link')
		  AND COALESCE(options, '') != ''
		""",
		as_dict=True,
	)
	custom = frappe.db.sql(
		"""
		SELECT dt AS parent, fieldname, label, fieldtype, options
		FROM `tabCustom Field`
		WHERE fieldtype IN ('Link', 'Table', 'Table MultiSelect', 'Dynamic Link')
		  AND COALESCE(options, '') != ''
		""",
		as_dict=True,
	)
	# Marcar custom para diferenciar visualmente.
	for f in standard:
		f["is_custom"] = 0
	for f in custom:
		f["is_custom"] = 1
	return standard + custom


@frappe.whitelist(methods=["GET", "POST"], allow_guest=False)
def get_schema_graph(module: str = "", search: str = "", include_aux: int = 1):
	"""Devuelve el grafo completo (o filtrado) del schema del site.

	Parámetros:
	- module: si se pasa, devuelve solo los DocTypes de ese módulo + sus
	  vecinos directos (1 hop). Vacío = todos.
	- search: filtra por nombre exacto/parcial (case-insensitive). Si hay match
	  devuelve el nodo + vecinos directos.
	- include_aux: si es 0, oculta DocTypes auxiliares (istable=1, child tables).
	  Útil para ver solo el "flujo de negocio" sin ruido técnico.

	Devuelve:
	{
		"nodes": [{id, label, module, custom, istable, issingle, fieldCount, linkCount}],
		"edges": [{id, source, target, label, type, custom}],
		"modules": ["Selling", "Stock", ...]  # solo en respuesta sin filtros
	}
	"""
	_require_login()
	include_aux = int(include_aux or 0)
	doctypes = _fetch_doctypes()
	fields = _fetch_doc_fields()

	# Pre-calcular cuántos campos y cuántos links tiene cada doctype.
	field_count = {}
	link_count = {}
	for f in fields:
		field_count[f["parent"]] = field_count.get(f["parent"], 0) + 1
		link_count[f["parent"]] = link_count.get(f["parent"], 0) + 1

	# Construir aristas primero. Para Link/Table/Table MultiSelect, options es
	# el nombre del DocType destino. Para Dynamic Link, options es el fieldname
	# que indica el destino — no podemos resolverlo sin data real, así que lo
	# marcamos como destino "?" y el frontend lo muestra como link "dinámico".
	edges = []
	for f in fields:
		src = f["parent"]
		if src not in doctypes:
			continue
		tgt = (f.get("options") or "").strip()
		if f["fieldtype"] == "Dynamic Link":
			# El "options" apunta al campo que decide el doctype destino.
			edges.append({
				"id": f"{src}::{f['fieldname']}",
				"source": src,
				"target": "*dynamic*",
				"label": f.get("label") or f["fieldname"],
				"fieldname": f["fieldname"],
				"type": "Dynamic Link",
				"dynamic_via": tgt,
				"custom": int(f.get("is_custom") or 0),
			})
			continue
		if not tgt or tgt not in doctypes:
			continue
		edges.append({
			"id": f"{src}::{f['fieldname']}",
			"source": src,
			"target": tgt,
			"label": f.get("label") or f["fieldname"],
			"fieldname": f["fieldname"],
			"type": f["fieldtype"],
			"custom": int(f.get("is_custom") or 0),
		})

	# Filtrar por módulo / búsqueda si corresponde.
	module = (module or "").strip()
	search = (search or "").strip().lower()
	if module or search:
		seed = set()
		for name, meta in doctypes.items():
			if module and meta.get("module") == module:
				seed.add(name)
			if search and search in name.lower():
				seed.add(name)
		# 1-hop expansion: incluir vecinos (origen o destino).
		expanded = set(seed)
		for e in edges:
			if e["source"] in seed and e["target"] in doctypes:
				expanded.add(e["target"])
			if e["target"] in seed:
				expanded.add(e["source"])
		visible = expanded
	else:
		visible = set(doctypes.keys())

	if not include_aux:
		visible = {n for n in visible if not doctypes[n].get("istable")}

	# Armar nodos.
	nodes = []
	for name in visible:
		meta = doctypes[name]
		nodes.append({
			"id": name,
			"label": name,
			"module": meta.get("module") or "",
			"custom": int(meta.get("custom") or 0),
			"istable": int(meta.get("istable") or 0),
			"issingle": int(meta.get("issingle") or 0),
			"fieldCount": field_count.get(name, 0),
			"linkCount": link_count.get(name, 0),
		})

	# Aristas solo entre nodos visibles. Las Dynamic Link las dejamos pasar
	# siempre si su origen es visible (el target "*dynamic*" lo agregamos como
	# nodo placeholder).
	visible_edges = []
	needs_dynamic = False
	for e in edges:
		if e["source"] not in visible:
			continue
		if e["type"] == "Dynamic Link":
			visible_edges.append(e)
			needs_dynamic = True
			continue
		if e["target"] not in visible:
			continue
		visible_edges.append(e)
	if needs_dynamic:
		nodes.append({
			"id": "*dynamic*",
			"label": "(destino dinámico)",
			"module": "",
			"custom": 0,
			"istable": 0,
			"issingle": 0,
			"fieldCount": 0,
			"linkCount": 0,
			"placeholder": 1,
		})

	# Lista de módulos disponibles (solo cuando no hay filtro, para popular
	# el sidebar; igualmente baratísimo de calcular siempre).
	modules = sorted({d.get("module") for d in doctypes.values() if d.get("module")})

	return {
		"nodes": nodes,
		"edges": visible_edges,
		"modules": modules,
		"total_doctypes": len(doctypes),
		"shown_doctypes": len(nodes),
	}


@frappe.whitelist(methods=["GET", "POST"], allow_guest=False)
def get_doctype_detail(name: str):
	"""Devuelve el detalle completo de un DocType: todos sus campos (no solo
	los Link), incoming edges (quién lo apunta), módulo, etc. Para el panel
	lateral cuando el usuario hace click en un nodo.
	"""
	_require_login()
	name = (name or "").strip()
	if not name:
		frappe.throw("Falta el nombre del DocType")
	# Validar que existe (evita SQL injection vía existencia).
	if not frappe.db.exists("DocType", name):
		frappe.throw(f"DocType '{name}' no existe")

	dt_row = frappe.db.get_value(
		"DocType", name,
		["name", "module", "custom", "istable", "issingle", "is_virtual",
		 "description", "autoname", "naming_rule"],
		as_dict=True,
	)
	# Campos: traemos todos (no solo Link) — útil ver tipos completos.
	# `unique` es palabra reservada en MySQL, por eso va con backticks.
	standard = frappe.db.sql(
		"""
		SELECT fieldname, label, fieldtype, options, reqd, `unique` AS is_unique,
			   COALESCE(description, '') AS description, idx, 0 AS is_custom
		FROM `tabDocField`
		WHERE parent = %s
		ORDER BY idx ASC
		""",
		(name,),
		as_dict=True,
	)
	custom_fields = frappe.db.sql(
		"""
		SELECT fieldname, label, fieldtype, options, reqd, `unique` AS is_unique,
			   COALESCE(description, '') AS description, idx, 1 AS is_custom
		FROM `tabCustom Field`
		WHERE dt = %s
		ORDER BY idx ASC
		""",
		(name,),
		as_dict=True,
	)
	# Quién apunta a este doctype (incoming Link/Table).
	incoming = frappe.db.sql(
		"""
		SELECT parent AS from_doctype, fieldname, fieldtype, label
		FROM `tabDocField`
		WHERE options = %s AND fieldtype IN ('Link', 'Table', 'Table MultiSelect')
		UNION ALL
		SELECT dt AS from_doctype, fieldname, fieldtype, label
		FROM `tabCustom Field`
		WHERE options = %s AND fieldtype IN ('Link', 'Table', 'Table MultiSelect')
		""",
		(name, name),
		as_dict=True,
	)
	# Conteo simple de registros para dar contexto ("Esta tabla tiene 1,245 rows").
	row_count = None
	try:
		safe_table = "tab" + name
		row_count = frappe.db.sql(f"SELECT COUNT(*) FROM `{safe_table}`")[0][0]
	except Exception:
		row_count = None

	return {
		"doctype": dt_row,
		"fields": standard + custom_fields,
		"incoming": incoming,
		"row_count": row_count,
		"table_name": "tab" + name,
	}
