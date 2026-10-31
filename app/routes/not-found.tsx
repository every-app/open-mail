// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { FileQuestion } from "lucide-react";
import { Link } from "react-router";
import { Button } from "~/components/ui/button";
import {
	Empty,
	EmptyContent,
	EmptyDescription,
	EmptyHeader,
	EmptyMedia,
	EmptyTitle,
} from "~/components/ui/empty";

export function meta() {
	return [{ title: "Page not found · OpenMail" }];
}

export default function NotFoundRoute() {
	return (
		<div className="flex min-h-dvh items-center justify-center bg-background p-8">
			<Empty>
				<EmptyHeader>
					<EmptyMedia variant="icon">
						<FileQuestion aria-hidden />
					</EmptyMedia>
					<EmptyTitle>Page not found</EmptyTitle>
					<EmptyDescription>The page you're looking for doesn't exist or has been moved.</EmptyDescription>
				</EmptyHeader>
				<EmptyContent>
					<Button render={<Link to="/" />} nativeButton={false}>
						Back to mailboxes
					</Button>
				</EmptyContent>
			</Empty>
		</div>
	);
}
