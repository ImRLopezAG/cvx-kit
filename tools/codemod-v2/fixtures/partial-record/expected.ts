import { z } from 'zod'
import { k } from 'cvx-kit'

const Role = z.enum(['admin', 'member'])

export const ByString = k.record(k.string(), k.string())
export const ByEnum = k.partialRecord(k.enum(['a', 'b']), k.number().finite())
export const ByLiterals = k.partialRecord(k.union([k.literal('a'), k.literal('b')]), k.number().finite())
export const ByReference = z.partialRecord(Role, z.number())
