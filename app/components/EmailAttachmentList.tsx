// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import {
	Download,
	File,
	FileArchive,
	FileImage,
	FileSpreadsheet,
	FileText,
	type LucideIcon,
	Paperclip,
} from "lucide-react";
import { IconTooltip } from "~/components/conversation/IconTooltip";
import { Button } from "~/components/ui/button";
import { cn } from "~/lib/cn";
import { downloadFile, formatBytes, getAttachmentUrl, getNonInlineAttachments } from "~/lib/utils";
import type { Attachment } from "~/types";

interface EmailAttachmentListProps {
	mailboxId?: string;
	emailId: string;
	attachments?: Attachment[];
	onPreviewImage?: (url: string, filename: string) => void;
	className?: string;
	showHeading?: boolean;
}

function iconFor(attachment: Attachment): LucideIcon {
	const type = attachment.mimetype ?? "";
	const ext = attachment.filename.split(".").pop()?.toLowerCase() ?? "";
	if (type.startsWith("image/")) return FileImage;
	if (type.includes("zip") || type.includes("compressed") || ["zip", "gz", "tar", "rar", "7z"].includes(ext)) return FileArchive;
	if (type.includes("spreadsheet") || type.includes("excel") || type === "text/csv" || ["csv", "xls", "xlsx"].includes(ext)) return FileSpreadsheet;
	if (type === "application/pdf" || type.startsWith("text/") || type.includes("word") || ["pdf", "doc", "docx", "txt", "md"].includes(ext)) return FileText;
	return File;
}

/** A message's attachments as cards: icon by type, name, size, download; images open the preview. */
export default function EmailAttachmentList({
	mailboxId,
	emailId,
	attachments,
	onPreviewImage,
	className,
	showHeading = false,
}: EmailAttachmentListProps) {
	if (!mailboxId) return null;

	const files = getNonInlineAttachments(attachments);
	if (files.length === 0) return null;

	return (
		<div className={className}>
			{showHeading && (
				<div className="mb-2 flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
					<Paperclip className="size-3.5" />
					{files.length} attachment{files.length !== 1 ? "s" : ""}
				</div>
			)}
			<ul className="flex flex-wrap gap-2">
				{files.map((attachment) => {
					const url = getAttachmentUrl(mailboxId, emailId, attachment.id);
					const isImage = attachment.mimetype?.startsWith("image/") && !!onPreviewImage;
					const Icon = iconFor(attachment);
					const body = (
						<>
							<span className="flex size-9 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground">
								<Icon className="size-4.5" />
							</span>
							<span className="min-w-0 flex-1">
								<span className="block truncate text-sm font-medium text-foreground">{attachment.filename}</span>
								<span className="block text-xs text-muted-foreground">{formatBytes(attachment.size)}</span>
							</span>
						</>
					);
					const cardClass =
						"flex min-w-0 flex-1 items-center gap-2.5 rounded-l-lg py-2 pl-2 pr-1 text-left outline-none focus-visible:ring-3 focus-visible:ring-ring/50";
					return (
						<li
							key={attachment.id}
							className="group flex w-60 max-w-full items-center rounded-lg border border-border bg-card transition-colors hover:bg-muted/50"
						>
							{isImage ? (
								<button
									type="button"
									onClick={() => onPreviewImage!(url, attachment.filename)}
									className={cardClass}
									aria-label={`Preview ${attachment.filename}`}
								>
									{body}
								</button>
							) : (
								<a href={url} target="_blank" rel="noopener noreferrer" className={cn(cardClass, "no-underline")}>
									{body}
								</a>
							)}
							<IconTooltip label="Download">
								<Button
									variant="ghost"
									size="icon-sm"
									className="mr-1.5"
									aria-label={`Download ${attachment.filename}`}
									onClick={() => downloadFile(url, attachment.filename)}
								>
									<Download />
								</Button>
							</IconTooltip>
						</li>
					);
				})}
			</ul>
		</div>
	);
}
