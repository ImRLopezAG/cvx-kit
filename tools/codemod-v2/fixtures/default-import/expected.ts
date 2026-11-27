import { paginated, k } from 'cvx-kit'

export const Defaulted = k.strictObject({ b: k.boolean() })
export const Page = paginated(Defaulted)
