import { z } from 'zod'

const Role = z.enum(['admin', 'member'])

export const ByString = z.partialRecord(z.string(), z.string())
export const ByEnum = z.partialRecord(z.enum(['a', 'b']), z.number())
export const ByLiterals = z.partialRecord(z.union([z.literal('a'), z.literal('b')]), z.number())
export const ByReference = z.partialRecord(Role, z.number())
