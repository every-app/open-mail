import { Check, Minus, Plus } from "lucide-react";
import { type ReactElement, useMemo, useState } from "react";
import { toast } from "sonner";
import { LabelDot } from "~/components/labels/LabelChip";
import { Input } from "~/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "~/components/ui/popover";
import { cn } from "~/lib/cn";
import { useCreateLabel, useLabels, useSetThreadLabels } from "~/queries/labels";
import type { Label } from "~/types";

/** One conversation the picker acts on: its key (thread id, else email id) and its labels now. */
export interface LabelTarget {
	threadKey: string;
	labels: Label[];
}

/**
 * Gmail's "Label as": a popover with a filter field, one checkbox per label
 * (checked when every target has it, a dash when some do) and "Create" for a
 * name that doesn't exist yet. Toggling applies at once to every target.
 *
 * Controlled (`open`/`onOpenChange`) so the `l` shortcut can open it.
 */
export function LabelPicker({
	mailboxId,
	targets,
	trigger,
	open,
	onOpenChange,
	align = "start",
}: {
	mailboxId: string;
	targets: LabelTarget[];
	/** The button that opens it, passed to Base UI's `render` prop. */
	trigger: ReactElement;
	open?: boolean;
	onOpenChange?: (open: boolean) => void;
	align?: "start" | "center" | "end";
}) {
	const { data: labels = [] } = useLabels(mailboxId);
	const setThreadLabels = useSetThreadLabels();
	const createLabel = useCreateLabel();
	const [filter, setFilter] = useState("");

	const query = filter.trim().toLowerCase();
	const shown = useMemo(
		() => labels.filter((l) => l.name.toLowerCase().includes(query)),
		[labels, query],
	);
	const exact = labels.some((l) => l.name.toLowerCase() === query);

	const stateOf = (labelId: string): "all" | "some" | "none" => {
		const n = targets.filter((t) => t.labels.some((l) => l.id === labelId)).length;
		return n === 0 ? "none" : n === targets.length ? "all" : "some";
	};

	const apply = (labelId: string, add: boolean) => {
		for (const t of targets) {
			const has = t.labels.some((l) => l.id === labelId);
			if (add === has) continue;
			setThreadLabels.mutate(
				{ mailboxId, threadKey: t.threadKey, ...(add ? { add: [labelId] } : { remove: [labelId] }) },
				{ onError: () => toast.error("Couldn't change the label. Try again.") },
			);
		}
	};

	const create = async () => {
		const name = filter.trim();
		if (!name) return;
		try {
			const label = await createLabel.mutateAsync({ mailboxId, name });
			apply(label.id, true);
			setFilter("");
			toast.success(`Label "${label.name}" created`);
		} catch {
			toast.error(`Couldn't create "${name}".`);
		}
	};

	return (
		<Popover
			open={open}
			onOpenChange={(next) => {
				if (!next) setFilter("");
				onOpenChange?.(next);
			}}
		>
			<PopoverTrigger render={trigger} />
			<PopoverContent align={align} className="w-64 gap-0 p-0">
				<div className="border-b border-border p-2">
					<div className="px-1 pb-1.5 text-xs font-medium text-muted-foreground">Label as:</div>
					<Input
						autoFocus
						value={filter}
						onChange={(e) => setFilter(e.target.value)}
						onKeyDown={(e) => {
							if (e.key === "Enter" && query && !exact) {
								e.preventDefault();
								void create();
							}
						}}
						placeholder="Filter or create"
						className="h-8"
						aria-label="Filter labels"
					/>
				</div>
				<div className="max-h-64 overflow-y-auto p-1" role="listbox" aria-multiselectable>
					{shown.map((label) => {
						const state = stateOf(label.id);
						return (
							<button
								key={label.id}
								type="button"
								role="option"
								aria-selected={state === "all"}
								onClick={() => apply(label.id, state !== "all")}
								className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-accent"
							>
								<span
									className={cn(
										"flex size-4 shrink-0 items-center justify-center rounded-[4px] border border-input",
										state !== "none" && "border-primary bg-primary text-primary-foreground",
									)}
								>
									{state === "all" && <Check className="size-3" />}
									{state === "some" && <Minus className="size-3" />}
								</span>
								<LabelDot color={label.color} />
								<span className="truncate">{label.name}</span>
							</button>
						);
					})}
					{shown.length === 0 && !query && (
						<div className="px-2 py-3 text-center text-sm text-muted-foreground">No labels yet</div>
					)}
				</div>
				{query && !exact && (
					<button
						type="button"
						onClick={() => void create()}
						disabled={createLabel.isPending}
						className="flex w-full items-center gap-2 border-t border-border px-3 py-2 text-left text-sm hover:bg-accent"
					>
						<Plus className="size-4" />
						<span className="truncate">Create "{filter.trim()}"</span>
					</button>
				)}
			</PopoverContent>
		</Popover>
	);
}
