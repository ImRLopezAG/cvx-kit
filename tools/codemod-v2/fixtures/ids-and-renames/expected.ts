import { k } from 'cvx-kit'
import { kContract } from 'cvx-kit/contracts'
import { effectApiBuilder } from 'cvx-kit/effect'

export const Ref = k.strictObject({ user: k.id('users'), team: k.id('teams').optional() })

export const contract = kContract(Ref)

export const api = effectApiBuilder({ input: Ref })
