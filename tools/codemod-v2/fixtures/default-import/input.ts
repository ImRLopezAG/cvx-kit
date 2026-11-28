import zed from 'zod'
import { paginated } from 'cvx-kit'

export const Defaulted = zed.strictObject({ b: zed.boolean() })
export const Page = paginated(Defaulted)
