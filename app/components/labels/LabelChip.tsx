import { X } from "lucide-react";
import { cn } from "~/lib/cn";
import type { Label, LabelColor } from "~/types";

export const LABEL_COLORS: LabelColor[] = [
	"slate",
	"rose",
	"amber",
	"lime",
	"emerald",
	"sky",
	"violet",
	"fuchsia",
];

/** The swatch dot for a label color (sidebar, pickers): the chip's text color, solid. */
export function LabelDot({ color, className }: { color: LabelColor; className?: string }) {
	return (
		<span
			aria-hidden
			className={cn(`tag-chip-${color} inline-block size-2.5 shrink-0 rounded-full bg-current!`, className)}
		/>
	);
}

/**
 * A label as a chip: before the subject in the list, beside it in the
 * conversation. With `onRemove`, an × removes it from the conversation.
 */
export function LabelChip({
	label,
	onRemove,
	className,
}: {
	label: Label;
	onRemove?: () => void;
	className?: string;
}) {
	return (
		<span
			className={cn(
				`tag-chip-${label.color} inline-flex h-5 max-w-48 shrink-0 items-center gap-0.5 rounded-md px-1.5 text-xs font-medium ring-1 ring-inset`,
				className,
			)}
			title={label.name}
		>
			<span className="truncate">{label.name}</span>
			{onRemove && (
				<button
					type="button"
					onClick={(e) => {
						e.stopPropagation();
						onRemove();
					}}
					className="-mr-1 rounded-sm p-0.5 opacity-70 hover:opacity-100"
					aria-label={`Remove label ${label.name}`}
				>
					<X className="size-3" />
				</button>
			)}
		</span>
	);
}
