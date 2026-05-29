"""Context para la página /db-map. Requiere login (no_cache=1 para evitar
caching cross-user)."""
import frappe

no_cache = 1


def get_context(context):
	if frappe.session.user == "Guest":
		frappe.local.flags.redirect_location = "/login?redirect-to=/db_map"
		raise frappe.Redirect
	context.no_cache = 1
	context.show_sidebar = False
	context.site_name = frappe.local.site
	context.current_user = frappe.session.user
	return context
