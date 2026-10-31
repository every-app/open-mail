import type { ReactElement, ReactNode } from "react";
import { Tooltip, TooltipContent, TooltipTrigger } from "~/components/ui/tooltip";

/** A tooltip on an icon button (the button is the trigger, through `render`). */
export function IconTooltip({
	label,
	children,
	side = "bottom",
}: {
	label: ReactNode;
	children: ReactElement;
	side?: "top" | "bottom" | "left" | "right";
}) {
	return (
		<Tooltip>
			<TooltipTrigger render={children} />
			<TooltipContent side={side}>{label}</TooltipContent>
		</Tooltip>
	);
}
