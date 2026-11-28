import { z } from 'zod'

export const Profile = z.strictObject({
	bio: z.string().nullish(),
	age: z.number().min(0).nullish(),
})
