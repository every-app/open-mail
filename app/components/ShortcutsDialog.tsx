import { Fragment } from "react";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
} from "~/components/ui/dialog";
import { useUIStore } from "~/hooks/useUIStore";

/** Every shortcut in docs/UI.md "Keyboard", grouped as Gmail's sheet is. */
const SHORTCUT_GROUPS: { title: string; items: { keys: string[][]; label: string }[] }[] = [
	{
		title: "Navigation",
		items: [
			{ keys: [["g", "i"]], label: "Go to Inbox" },
			{ keys: [["g", "s"]], label: "Go to Sent" },
			{ keys: [["g", "d"]], label: "Go to Drafts" },
			{ keys: [["g", "a"]], label: "Go to Archive" },
			{ keys: [["g", "t"]], label: "Go to Trash" },
			{ keys: [["/"]], label: "Search mail" },
			{ keys: [["j"], ["k"]], label: "Next / previous conversation" },
			{ keys: [["o"], ["Enter"]], label: "Open conversation" },
			{ keys: [["u"]], label: "Back to the list" },
		],
	},
	{
		title: "Actions",
		items: [
			{ keys: [["c"]], label: "Compose" },
			{ keys: [["r"]], label: "Reply" },
			{ keys: [["a"]], label: "Reply all" },
			{ keys: [["f"]], label: "Forward" },
			{ keys: [["e"]], label: "Archive" },
			{ keys: [["#"]], label: "Delete" },
			{ keys: [["!"]], label: "Report spam" },
			{ keys: [["s"]], label: "Star" },
			{ keys: [["x"]], label: "Select conversation" },
			{ keys: [["l"]], label: "Label as" },
			{ keys: [["Shift", "i"]], label: "Mark as read" },
			{ keys: [["Shift", "u"]], label: "Mark as unread" },
			{ keys: [["?"]], label: "Show keyboard shortcuts" },
		],
	},
];

function Kbd({ children }: { children: string }) {
	return (
		<kbd className="inline-flex h-5 min-w-5 items-center justify-center rounded border border-border bg-muted px-1.5 font-mono text-[11px] font-medium text-foreground">
			{children}
		</kbd>
	);
}

/** Opens with `?` (wired in the mailbox shell) or `useUIStore().setShortcutsOpen(true)`. */
export default function ShortcutsDialog() {
	const open = useUIStore((s) => s.isShortcutsOpen);
	const setOpen = useUIStore((s) => s.setShortcutsOpen);

	return (
		<Dialog open={open} onOpenChange={setOpen}>
			<DialogContent className="sm:max-w-2xl">
				<DialogHeader>
					<DialogTitle>Keyboard shortcuts</DialogTitle>
					<DialogDescription>
						Shortcuts work anywhere outside a text field.
					</DialogDescription>
				</DialogHeader>
				<div className="grid gap-6 sm:grid-cols-2">
					{SHORTCUT_GROUPS.map((group) => (
						<section key={group.title}>
							<h3 className="mb-2 text-xs font-medium text-muted-foreground">{group.title}</h3>
							<dl className="space-y-1.5">
								{group.items.map((item) => (
									<div key={item.label} className="flex items-center justify-between gap-4 text-sm">
										<dt>{item.label}</dt>
										<dd className="flex shrink-0 items-center gap-1 text-xs text-muted-foreground">
											{item.keys.map((combo, i) => (
												<Fragment key={combo.join("+")}>
													{i > 0 && <span>/</span>}
													{combo.map((k, j) => (
														<Fragment key={k}>
															{j > 0 && <span>{combo[0] === "Shift" ? "+" : "then"}</span>}
															<Kbd>{k}</Kbd>
														</Fragment>
													))}
												</Fragment>
											))}
										</dd>
									</div>
								))}
							</dl>
						</section>
					))}
				</div>
			</DialogContent>
		</Dialog>
	);
}
