import { k } from 'cvx-kit'
export const Base = k.object({ a: k.string(), b: k.string() })
export const A = Base.partial('a')
export const B = Base.required('b')
