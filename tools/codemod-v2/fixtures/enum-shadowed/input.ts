import { z } from 'zod'
export const Status = { A: 'a' } as const
export function schema(Status: any) { return z.enum(Status) }
