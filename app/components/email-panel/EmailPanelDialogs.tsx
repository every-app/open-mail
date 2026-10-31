// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { Download } from "lucide-react";
import { Button } from "~/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "~/components/ui/dialog";
import { downloadFile } from "~/lib/utils";
import type { Email } from "~/types";

interface PreviewImage {
	url: string;
	filename: string;
}

interface EmailPanelDialogsProps {
	sourceViewEmail: Email | null;
	previewImage: PreviewImage | null;
	onCloseSource: () => void;
	onClosePreview: () => void;
}

function getSourceHeaders(msg: Email): { key: string; value: string }[] {
	if (msg.raw_headers) {
		try {
			const parsed = JSON.parse(msg.raw_headers);
			if (Array.isArray(parsed)) {
				return parsed.map((header) => ({
					key: header.key || header.name || "",
					value: String(header.value || ""),
				}));
			}
			if (typeof parsed === "object" && parsed !== null) {
				return Object.entries(parsed).map(([key, value]) => ({
					key,
					value: String(value),
				}));
			}
		} catch {
			// Fall through to field-based headers.
		}
	}

	const headers: { key: string; value: string }[] = [];
	if (msg.sender) headers.push({ key: "From", value: msg.sender });
	if (msg.recipient) headers.push({ key: "To", value: msg.recipient });
	if (msg.cc) headers.push({ key: "Cc", value: msg.cc });
	if (msg.bcc) headers.push({ key: "Bcc", value: msg.bcc });
	if (msg.subject) headers.push({ key: "Subject", value: msg.subject });
	if (msg.date) headers.push({ key: "Date", value: msg.date });
	if (msg.message_id) headers.push({ key: "Message-ID", value: msg.message_id });
	if (msg.in_reply_to) headers.push({ key: "In-Reply-To", value: msg.in_reply_to });
	if (msg.email_references) {
		headers.push({ key: "References", value: msg.email_references });
	}
	if (msg.thread_id) headers.push({ key: "X-Thread-ID", value: msg.thread_id });
	return headers;
}

export default function EmailPanelDialogs({
	sourceViewEmail,
	previewImage,
	onCloseSource,
	onClosePreview,
}: EmailPanelDialogsProps) {
	const sourceHeaders = sourceViewEmail ? getSourceHeaders(sourceViewEmail) : [];

	return (
		<>
			<Dialog
				open={sourceViewEmail !== null}
				onOpenChange={(open) => {
					if (!open) onCloseSource();
				}}
			>
				<DialogContent className="sm:max-w-3xl">
					<DialogHeader>
						<DialogTitle>Original message</DialogTitle>
						{sourceViewEmail && (
							<DialogDescription className="truncate">{sourceViewEmail.subject}</DialogDescription>
						)}
					</DialogHeader>
					<div className="max-h-[60vh] overflow-y-auto rounded-lg border border-border">
						{sourceHeaders.length > 0 ? (
							<table className="w-full border-collapse text-xs">
								<tbody>
									{sourceHeaders.map((header, idx) => (
										<tr key={`${header.key}-${idx}`} className="border-b border-border last:border-b-0 even:bg-muted/40">
											<td className="w-40 px-3 py-1.5 align-top font-mono font-semibold whitespace-nowrap text-foreground">
												{header.key}
											</td>
											<td className="px-3 py-1.5 font-mono break-all text-muted-foreground">{header.value}</td>
										</tr>
									))}
								</tbody>
							</table>
						) : (
							<p className="py-8 text-center text-sm text-muted-foreground">No header data available for this email.</p>
						)}
					</div>
					<DialogFooter showCloseButton />
				</DialogContent>
			</Dialog>

			<Dialog
				open={previewImage !== null}
				onOpenChange={(open) => {
					if (!open) onClosePreview();
				}}
			>
				<DialogContent className="sm:max-w-3xl">
					<DialogHeader>
						<DialogTitle className="truncate pr-8">{previewImage?.filename}</DialogTitle>
					</DialogHeader>
					{previewImage && (
						<div className="flex min-h-[200px] items-center justify-center rounded-lg bg-muted p-4">
							<img
								src={previewImage.url}
								alt={previewImage.filename}
								className="max-h-[70vh] max-w-full rounded object-contain shadow-sm"
							/>
						</div>
					)}
					<DialogFooter showCloseButton>
						<Button
							variant="outline"
							onClick={() => {
								if (previewImage) downloadFile(previewImage.url, previewImage.filename);
							}}
						>
							<Download />
							Download
						</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>
		</>
	);
}
