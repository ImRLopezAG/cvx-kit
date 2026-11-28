import { z } from 'zod'
export const A = z.string().normalize('NFC')
export const B = z.string().startsWith('hi')
