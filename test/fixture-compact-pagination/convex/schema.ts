import { defineSchema } from 'convex/server'
import { clients, users, contacts, ids, events } from './tables'
export default defineSchema({
	clients: clients.table,
	users: users.table,
	contacts: contacts.table,
	ids: ids.table,
	events: events.table,
})
