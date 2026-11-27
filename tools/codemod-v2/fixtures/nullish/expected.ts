import { k } from 'cvx-kit'

export const Profile = k.strictObject({
	bio: k.string().nullable().optional(),
	age: k.number().finite().min(0).nullable().optional(),
})
