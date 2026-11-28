import type { KType } from 'cvx-kit';
import { k } from 'cvx-kit';
import * as kit from 'cvx-kit';

export const S = k.string();
export type T = KType | k.infer<typeof S>;
export const table = kit.kTable;
