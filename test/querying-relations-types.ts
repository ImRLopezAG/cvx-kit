import type { GenericId } from 'convex/values'
import type { DataModelFromSchemaDefinition } from 'convex/server'
import type { ManagedQueryContext } from '../src/querying/security'
import { relationshipFixture } from './fixture-querying/relationships'

const f = relationshipFixture()
declare const ctx: ManagedQueryContext<DataModelFromSchemaDefinition<typeof f.schema>>
declare const taskId: GenericId<'tasks'>
declare const labelId: GenericId<'labels'>
const q = f.querying(ctx).tasks
q.where({ labels: { none: { owner: { ordinal: 1 } } } })
q.with({ labels: { owner: { requiredLabel: true } }, referenceTask: true })
	.paginate({
		numItems: 1,
		cursor: null,
		filters: { labels: { some: { owner: { ordinal: 1 } } }, referenceTask: null },
	})
	.then((p) => {
		const label: GenericId<'labels'> = p.page[0].labels.page[0]._id
		const owner: GenericId<'tasks'> | undefined = p.page[0].labels.page[0].owner?._id
		void label
		void owner
		// @ts-expect-error DTO omits tenant
		void p.page[0].labels.page[0].tenant
	})
q.relation(taskId, 'labels.owner.labels')
	.with({ owner: true })
	.paginate({ numItems: 1, cursor: null, filters: { owner: { ordinal: 1 } } })
	.then((p) => {
		const id: GenericId<'labels'> = p.page[0]._id
		void id
	})
// @ts-expect-error foreign parent ID branding
q.relation(labelId, 'labels')
// @ts-expect-error unknown declared edge
q.relation(taskId, 'missing')
// @ts-expect-error one edge has no paginated continuation
q.relation(taskId, 'referenceTask')
// @ts-expect-error unknown nested path
q.relation(taskId, 'labels.missing')
// @ts-expect-error wrong nested scalar type
q.paginate({ numItems: 1, cursor: null, filters: { labels: { some: { ordinal: '1' } } } })
// @ts-expect-error unknown nested output
q.with({ labels: { missing: true } })
// @ts-expect-error no target callback escape
q.relation(taskId, 'labels').where(() => true)
// @ts-expect-error route consumes one level, so this selected fifth edge is forbidden
q.relation(taskId, 'labels').with({ owner: { labels: { owner: { labels: true } } } })
// @ts-expect-error a depth-four route has no remaining selected edges
q.relation(taskId, 'referenceTask.labels.owner.labels').with({ owner: true })
q.relation(taskId, 'referenceTask.labels').with({ owner: { labels: true } })
q.relation(taskId, 'referenceTask.labels.owner.labels').with({})
