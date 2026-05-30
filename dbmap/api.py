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


_MAX_FIELDS_PREVIEW = 12  # campos Link/Table que metemos en cada nodo del ERD.


@frappe.whitelist(methods=["GET", "POST"], allow_guest=False)
def list_doctypes(search: str = "", module: str = "", limit: int = 30):
	"""Lista plana de DocTypes para el autocomplete del buscador.

	Devuelve hasta `limit` resultados ordenados por relevancia (exact match
	primero, luego startswith, luego contains). Cada item trae el conteo de
	relaciones para que el frontend muestre un badge.
	"""
	_require_login()
	search = (search or "").strip().lower()
	module = (module or "").strip()
	limit = max(1, min(int(limit or 30), 100))

	doctypes = _fetch_doctypes()
	link_counts = {}
	for f in _fetch_doc_fields():
		link_counts[f["parent"]] = link_counts.get(f["parent"], 0) + 1

	def score(name):
		nlow = name.lower()
		if nlow == search: return 0
		if nlow.startswith(search): return 1
		return 2

	results = []
	for name, meta in doctypes.items():
		if module and meta.get("module") != module:
			continue
		if search and search not in name.lower():
			continue
		results.append({
			"name": name,
			"module": meta.get("module") or "",
			"istable": int(meta.get("istable") or 0),
			"custom": int(meta.get("custom") or 0),
			"linkCount": link_counts.get(name, 0),
			"_score": score(name) if search else 99,
		})

	results.sort(key=lambda r: (r["_score"], r["name"].lower()))
	for r in results:
		r.pop("_score", None)
	return {"results": results[:limit], "total": len(results)}


@frappe.whitelist(methods=["GET", "POST"], allow_guest=False)
def get_schema_graph(module: str = "", search: str = "", doctype: str = "",
					 include_aux: int = 0, expand_neighbors: int = 0):
	"""Devuelve el grafo (estilo ERD) del schema del site.

	Parámetros:
	- module: filtra a los DocTypes de ese módulo. Vacío = todos.
	- search: filtra por nombre parcial (case-insensitive).
	- include_aux: si 0 (default), oculta child tables. Reduce ruido brutalmente.
	- expand_neighbors: si 1, agrega vecinos a 1 hop (DocTypes referenciados desde
	  o hacia el seed). Default 0 para no caer en el hairball de antes.

	Cada nodo trae `fields_summary`: lista de hasta 12 campos Link/Table con su
	destino — el frontend los renderiza dentro del rectángulo del ERD.

	Devuelve {nodes, edges, modules, total_doctypes, shown_doctypes}.
	"""
	_require_login()
	include_aux = int(include_aux or 0)
	expand_neighbors = int(expand_neighbors or 0)
	doctypes = _fetch_doctypes()
	fields = _fetch_doc_fields()

	# Indexamos los fields por parent para poder armar fields_summary por nodo
	# sin recorrer todo cada vez.
	fields_by_parent = {}
	for f in fields:
		fields_by_parent.setdefault(f["parent"], []).append(f)

	# Construir aristas globales.
	edges = []
	for f in fields:
		src = f["parent"]
		if src not in doctypes:
			continue
		tgt = (f.get("options") or "").strip()
		if f["fieldtype"] == "Dynamic Link":
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

	module = (module or "").strip()
	search = (search or "").strip().lower()
	doctype = (doctype or "").strip()

	# Caso "focused": el user pidió UN doctype puntual. Auto-activamos vecinos
	# y NO aplicamos el filtro de aux (queremos ver child tables relevantes).
	if doctype:
		if doctype not in doctypes:
			frappe.throw(f"DocType '{doctype}' no existe")
		seed = {doctype}
		expanded = set(seed)
		for e in edges:
			if e["source"] in seed and e["target"] in doctypes:
				expanded.add(e["target"])
			if e["target"] in seed:
				expanded.add(e["source"])
		visible = expanded
		# El modo focused ignora include_aux=0: child tables relacionadas SÍ
		# se muestran porque son parte del modelo del doctype focused.
		include_aux = 1
	elif module or search:
		seed = set()
		for name, meta in doctypes.items():
			if module and meta.get("module") == module:
				seed.add(name)
			if search and search in name.lower():
				seed.add(name)
		if expand_neighbors:
			expanded = set(seed)
			for e in edges:
				if e["source"] in seed and e["target"] in doctypes:
					expanded.add(e["target"])
				if e["target"] in seed:
					expanded.add(e["source"])
			visible = expanded
		else:
			visible = seed
	else:
		visible = set(doctypes.keys())

	if not include_aux:
		visible = {n for n in visible if not doctypes[n].get("istable")}

	# Armar nodos con fields_summary embebido.
	nodes = []
	for name in visible:
		meta = doctypes[name]
		raw_fields = fields_by_parent.get(name, [])
		summary = []
		for f in raw_fields[:_MAX_FIELDS_PREVIEW]:
			tgt = (f.get("options") or "").strip()
			summary.append({
				"label": f.get("label") or f["fieldname"],
				"fieldname": f["fieldname"],
				"fieldtype": f["fieldtype"],
				"target": tgt if f["fieldtype"] != "Dynamic Link" else "(dinámico)",
				"custom": int(f.get("is_custom") or 0),
			})
		nodes.append({
			"id": name,
			"label": name,
			"module": meta.get("module") or "",
			"custom": int(meta.get("custom") or 0),
			"istable": int(meta.get("istable") or 0),
			"issingle": int(meta.get("issingle") or 0),
			"fieldCount": len(raw_fields),
			"linkCount": len(raw_fields),
			"fields_summary": summary,
			"more_fields": max(0, len(raw_fields) - _MAX_FIELDS_PREVIEW),
		})

	# Filtrar aristas a las que conectan nodos visibles (o son Dynamic Link).
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
			"module": "", "custom": 0, "istable": 0, "issingle": 0,
			"fieldCount": 0, "linkCount": 0,
			"fields_summary": [], "more_fields": 0,
			"placeholder": 1,
		})

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
