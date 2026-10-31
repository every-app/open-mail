import type { ReactNode } from "react";

/**
 * A page's title, with an optional subtitle and actions on the right, and an
 * optional way back above it (OpenCRM's PageHeader).
 */
export function PageHeader({
	title,
	description,
	actions,
	backLink,
}: {
	title: ReactNode;
	description?: ReactNode;
	actions?: ReactNode;
	backLink?: ReactNode;
}) {
	return (
		<div className="space-y-3">
			{backLink}
			<div className="flex flex-wrap items-start justify-between gap-3">
				<div className="min-w-0 flex-1 basis-64 space-y-1">
					<h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
					{description ? <div className="text-sm text-muted-foreground">{description}</div> : null}
				</div>
				{actions ? <div className="flex max-w-full shrink-0 flex-wrap items-center gap-2">{actions}</div> : null}
			</div>
		</div>
	);
}
