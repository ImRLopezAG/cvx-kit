import { paginated, k } from 'cvx-kit'

export const Defaulted = k.object({ b: k.boolean() })
export const Page = paginated(Defaulted)
