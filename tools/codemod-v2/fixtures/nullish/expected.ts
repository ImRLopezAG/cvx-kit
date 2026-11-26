import { k } from 'cvx-kit'

export const Profile = k.object({
	bio: k.string().nullable().optional(),
	age: k.number().min(0).nullable().optional(),
})
