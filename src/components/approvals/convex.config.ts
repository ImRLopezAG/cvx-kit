import workflow from '@convex-dev/workflow/convex.config'
import auditLog from 'convex-audit-log/convex.config.js'
import { defineComponent } from 'convex/server'

const approvals = defineComponent('approvals')

approvals.use(workflow, { name: 'workflow' })
approvals.use(auditLog, { name: 'auditLog' })

export default approvals
