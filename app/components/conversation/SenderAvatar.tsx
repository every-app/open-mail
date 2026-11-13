import { cn } from "~/lib/cn";
import { avatarColor, initialOf, parsePerson } from "./people";

/**
 * A sender's initial on a tag-chip tone picked from the address. `name` is
 * the display name when the address alone doesn't carry it; `self` (mail the
 * mailbox sent, and its drafts) uses the primary tone so "you" reads the same
 * everywhere in a thread.
 */
export function SenderAvatar({
	sender,
	name,
	self,
	className,
}: {
	sender: string;
	name?: string;
	self?: boolean;
	className?: string;
}) {
	const parsed = parsePerson(sender);
	const person = name ? { ...parsed, name, hasName: true } : parsed;
	return (
		<span
			aria-hidden
			className={cn(
				"flex size-8 shrink-0 items-center justify-center rounded-full text-sm font-semibold ring-1 ring-inset select-none",
				self ? "bg-primary/12 text-primary ring-primary/25" : `tag-chip-${avatarColor(person.address)}`,
				className,
			)}
		>
			{initialOf(person)}
		</span>
	);
}
