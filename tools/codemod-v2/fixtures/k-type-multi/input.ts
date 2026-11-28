import type { k, KType } from 'cvx-kit';
import * as kit from 'cvx-kit';
import { z } from 'zod';

export const S = z.string();
export type T = KType | k.infer<typeof S>;
export const table = kit.kTable;
