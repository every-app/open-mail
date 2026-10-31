import { cn } from "~/lib/cn";
import { avatarColor, initialOf, parsePerson } from "./people";

/** A sender's initial on a tag-chip tone picked from the address. */
export function SenderAvatar({ sender, className }: { sender: string; className?: string }) {
	const person = parsePerson(sender);
	return (
		<span
			aria-hidden
			className={cn(
				`tag-chip-${avatarColor(person.address)} flex size-8 shrink-0 items-center justify-center rounded-full text-sm font-semibold ring-1 ring-inset select-none`,
				className,
			)}
		>
			{initialOf(person)}
		</span>
	);
}
