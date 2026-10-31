import { Pencil } from "lucide-react";
import type { ReactNode } from "react";
import { Button } from "~/components/ui/button";
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "~/components/ui/empty";
import { useUIStore } from "~/hooks/useUIStore";

/** An empty list: icon, title, the helpful copy, and Compose where it helps. */
export function ListEmpty({
	icon,
	title,
	description,
	showCompose = false,
	children,
}: {
	icon: ReactNode;
	title: string;
	description?: ReactNode;
	showCompose?: boolean;
	children?: ReactNode;
}) {
	return (
		<Empty className="py-20">
			<EmptyHeader>
				<EmptyMedia variant="icon">{icon}</EmptyMedia>
				<EmptyTitle>{title}</EmptyTitle>
				{description && <EmptyDescription>{description}</EmptyDescription>}
			</EmptyHeader>
			{(showCompose || children) && (
				<EmptyContent>
					{children}
					{showCompose && (
						<Button onClick={() => useUIStore.getState().openCompose()}>
							<Pencil />
							Compose
						</Button>
					)}
				</EmptyContent>
			)}
		</Empty>
	);
}
