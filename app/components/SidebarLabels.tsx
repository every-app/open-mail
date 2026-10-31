import { ChevronRight, EllipsisVertical, Pencil, Plus, Tag, Trash2 } from "lucide-react";
import { type FormEvent, useMemo, useState } from "react";
import { NavLink, useNavigate, useParams } from "react-router";
import { toast } from "sonner";
import { LABEL_COLORS, LabelDot } from "~/components/labels/LabelChip";
import {
	AlertDialog,
	AlertDialogAction,
	AlertDialogCancel,
	AlertDialogContent,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogTitle,
} from "~/components/ui/alert-dialog";
import { Button } from "~/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "~/components/ui/collapsible";
import {
	Dialog,
	DialogClose,
	DialogContent,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "~/components/ui/dialog";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "~/components/ui/dropdown-menu";
import { Input } from "~/components/ui/input";
import { Label as FieldLabel } from "~/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "~/components/ui/select";
import { Tooltip, TooltipContent, TooltipTrigger } from "~/components/ui/tooltip";
import { cn } from "~/lib/cn";
import { folderPath, labelPath } from "~/lib/mail-paths";
import { useCreateLabel, useDeleteLabel, useLabels, useUpdateLabel } from "~/queries/labels";
import { ApiError } from "~/services/api";
import type { LabelColor, LabelWithCount } from "~/types";

/** A label tree node: a label, or a parent that only exists as a prefix (`Work` of `Work/Travel`). */
interface LabelNode {
	path: string;
	segment: string;
	label?: LabelWithCount;
	children: LabelNode[];
}

function buildTree(labels: LabelWithCount[]): LabelNode[] {
	const roots: LabelNode[] = [];
	const sorted = [...labels].sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
	for (const label of sorted) {
		let level = roots;
		let path = "";
		for (const segment of label.name.split("/")) {
			path = path ? `${path}/${segment}` : segment;
			let node = level.find((n) => n.path === path);
			if (!node) {
				node = { path, segment, children: [] };
				level.push(node);
			}
			if (path === label.name) node.label = label;
			level = node.children;
		}
	}
	return roots;
}

/** The label a node links to: its own, else its first descendant's. */
function firstLabel(node: LabelNode): LabelWithCount | undefined {
	return node.label ?? node.children.map(firstLabel).find(Boolean);
}

const COLOR_NAMES: Record<LabelColor, string> = {
	slate: "Slate",
	rose: "Rose",
	amber: "Amber",
	lime: "Lime",
	emerald: "Emerald",
	sky: "Sky",
	violet: "Violet",
	fuchsia: "Fuchsia",
};

function ColorSwatches({ value, onChange }: { value: LabelColor; onChange: (color: LabelColor) => void }) {
	return (
		<div role="radiogroup" aria-label="Color" className="flex flex-wrap gap-2">
			{LABEL_COLORS.map((color) => (
				<button
					key={color}
					type="button"
					role="radio"
					aria-checked={value === color}
					aria-label={COLOR_NAMES[color]}
					title={COLOR_NAMES[color]}
					onClick={() => onChange(color)}
					className={cn(
						"flex size-8 items-center justify-center rounded-full outline-none focus-visible:ring-3 focus-visible:ring-ring/50",
						value === color ? "ring-2 ring-foreground/70 ring-offset-2 ring-offset-background" : "hover:scale-110",
					)}
				>
					<LabelDot color={color} className="size-6" />
				</button>
			))}
		</div>
	);
}

const NO_PARENT = "__none__";

function errorText(error: unknown, fallback: string): string {
	if (error instanceof ApiError && error.status === 409) return "A label with that name already exists.";
	if (error instanceof Error && error.message) return error.message;
	return fallback;
}

/** Create (name, optional parent, color) or edit (name, color) a label. */
function LabelDialog({
	mailboxId,
	open,
	onOpenChange,
	editing,
	parents,
}: {
	mailboxId: string;
	open: boolean;
	onOpenChange: (open: boolean) => void;
	/** The label being edited; absent to create one. */
	editing?: LabelWithCount;
	/** Paths a new label can nest under. */
	parents: string[];
}) {
	const createLabel = useCreateLabel();
	const updateLabel = useUpdateLabel();
	const [name, setName] = useState(editing?.name ?? "");
	const [parent, setParent] = useState<string>(NO_PARENT);
	const [color, setColor] = useState<LabelColor>(editing?.color ?? "slate");
	const [error, setError] = useState<string | null>(null);
	const pending = createLabel.isPending || updateLabel.isPending;

	const submit = async (e: FormEvent) => {
		e.preventDefault();
		const trimmed = name.trim().replace(/^\/+|\/+$/g, "");
		if (!trimmed) return;
		setError(null);
		try {
			if (editing) {
				await updateLabel.mutateAsync({ mailboxId, labelId: editing.id, name: trimmed, color });
			} else {
				const full = parent === NO_PARENT ? trimmed : `${parent}/${trimmed}`;
				await createLabel.mutateAsync({ mailboxId, name: full, color });
				toast.success(`Label "${full}" created`);
			}
			onOpenChange(false);
		} catch (err) {
			setError(errorText(err, editing ? "Couldn't save the label. Try again." : "Couldn't create the label. Try again."));
		}
	};

	const parentItems = [{ value: NO_PARENT, label: "None" }, ...parents.map((p) => ({ value: p, label: p }))];

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent>
				<form onSubmit={submit} className="grid gap-4">
					<DialogHeader>
						<DialogTitle>{editing ? "Edit label" : "New label"}</DialogTitle>
					</DialogHeader>
					<div className="grid gap-2">
						<FieldLabel htmlFor="label-name">Label name</FieldLabel>
						<Input
							id="label-name"
							placeholder="e.g. Customers"
							value={name}
							onChange={(e) => setName(e.target.value)}
							autoFocus
							required
						/>
						{editing && <p className="text-xs text-muted-foreground">Use / to nest it, as in Work/Travel.</p>}
					</div>
					{!editing && parents.length > 0 && (
						<div className="grid gap-2">
							<FieldLabel htmlFor="label-parent">Nest label under</FieldLabel>
							<Select items={parentItems} value={parent} onValueChange={(v) => setParent(typeof v === "string" ? v : NO_PARENT)}>
								<SelectTrigger id="label-parent" className="w-full">
									<SelectValue />
								</SelectTrigger>
								<SelectContent>
									{parentItems.map((item) => (
										<SelectItem key={item.value} value={item.value}>
											{item.label}
										</SelectItem>
									))}
								</SelectContent>
							</Select>
						</div>
					)}
					<div className="grid gap-2">
						<span className="text-sm font-medium">Color</span>
						<ColorSwatches value={color} onChange={setColor} />
					</div>
					{error && <p className="text-sm text-destructive">{error}</p>}
					<DialogFooter>
						<DialogClose render={<Button type="button" variant="outline" />}>Cancel</DialogClose>
						<Button type="submit" disabled={!name.trim()} pending={pending}>
							{editing ? "Save" : "Create"}
						</Button>
					</DialogFooter>
				</form>
			</DialogContent>
		</Dialog>
	);
}

function LabelRow({
	node,
	depth,
	mailboxId,
	activeLabelId,
	collapsedPaths,
	onToggle,
	onEdit,
	onDelete,
	onNavigate,
}: {
	node: LabelNode;
	depth: number;
	mailboxId: string;
	activeLabelId?: string;
	collapsedPaths: Set<string>;
	onToggle: (path: string) => void;
	onEdit: (label: LabelWithCount) => void;
	onDelete: (label: LabelWithCount) => void;
	onNavigate?: () => void;
}) {
	const { label } = node;
	const hasChildren = node.children.length > 0;
	const open = !collapsedPaths.has(node.path);
	const active = !!label && label.id === activeLabelId;
	const unread = label?.unreadCount ?? 0;
	const indent = { paddingLeft: `${20 + depth * 16}px` };

	const content = (
		<>
			{label ? <LabelDot color={label.color} /> : <Tag className="size-3.5 shrink-0 text-muted-foreground" />}
			<span className="flex-1 truncate">{node.segment}</span>
			{unread > 0 && <span className="text-xs tabular-nums group-hover/label:invisible group-focus-within/label:invisible">{unread}</span>}
		</>
	);
	const rowClass = cn(
		"flex h-8 w-full items-center gap-3 rounded-full pr-3 text-left text-sm text-sidebar-foreground/80 transition-colors outline-none hover:bg-sidebar-accent/60 hover:text-sidebar-foreground focus-visible:ring-2 focus-visible:ring-sidebar-ring",
		unread > 0 && "font-semibold text-sidebar-foreground",
		active && "bg-sidebar-accent font-semibold text-sidebar-accent-foreground hover:bg-sidebar-accent",
	);

	return (
		<li>
			<div className="group/label relative">
				{label ? (
					<NavLink to={labelPath(mailboxId, label.id)} onClick={onNavigate} className={rowClass} style={indent}>
						{content}
					</NavLink>
				) : (
					<button type="button" onClick={() => onToggle(node.path)} className={rowClass} style={indent} aria-expanded={open}>
						{content}
					</button>
				)}
				{hasChildren && (
					<button
						type="button"
						onClick={() => onToggle(node.path)}
						aria-label={open ? `Collapse ${node.path}` : `Expand ${node.path}`}
						aria-expanded={open}
						className="absolute top-1/2 flex size-4 -translate-y-1/2 items-center justify-center rounded-sm text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-sidebar-ring"
						style={{ left: `${2 + depth * 16}px` }}
					>
						<ChevronRight className={cn("size-3.5 transition-transform", open && "rotate-90")} />
					</button>
				)}
				{label && (
					<DropdownMenu>
						<DropdownMenuTrigger
							render={
								<Button
									variant="ghost"
									size="icon-xs"
									aria-label={`${label.name} options`}
									className="absolute top-1/2 right-1.5 -translate-y-1/2 text-muted-foreground opacity-0 group-hover/label:opacity-100 focus-visible:opacity-100 aria-expanded:opacity-100"
								>
									<EllipsisVertical />
								</Button>
							}
						/>
						<DropdownMenuContent align="start" side="right" className="w-40">
							<DropdownMenuItem onClick={() => onEdit(label)}>
								<Pencil />
								Edit
							</DropdownMenuItem>
							<DropdownMenuSeparator />
							<DropdownMenuItem variant="destructive" onClick={() => onDelete(label)}>
								<Trash2 />
								Delete
							</DropdownMenuItem>
						</DropdownMenuContent>
					</DropdownMenu>
				)}
			</div>
			{hasChildren && open && (
				<ul className="mt-0.5 space-y-0.5">
					{node.children.map((child) => (
						<LabelRow
							key={child.path}
							node={child}
							depth={depth + 1}
							mailboxId={mailboxId}
							activeLabelId={activeLabelId}
							collapsedPaths={collapsedPaths}
							onToggle={onToggle}
							onEdit={onEdit}
							onDelete={onDelete}
							onNavigate={onNavigate}
						/>
					))}
				</ul>
			)}
		</li>
	);
}

/**
 * The sidebar's "Labels" section (docs/UI.md "Labels"), under Folders: `+`
 * to create, the labels as a tree by `/` (collapsible parents), each with its
 * unread count and a menu (Edit, Delete). `collapsed` is the desktop icon
 * rail: a tag per top-level label. `onNavigate` closes the mobile sheet.
 */
export default function SidebarLabels({
	mailboxId,
	collapsed,
	onNavigate,
}: {
	mailboxId: string;
	collapsed: boolean;
	onNavigate?: () => void;
}) {
	const { labelId: activeLabelId } = useParams();
	const navigate = useNavigate();
	const { data: labels = [] } = useLabels(mailboxId);
	const deleteLabel = useDeleteLabel();
	const tree = useMemo(() => buildTree(labels), [labels]);
	const [sectionOpen, setSectionOpen] = useState(true);
	const [collapsedPaths, setCollapsedPaths] = useState<Set<string>>(() => new Set());
	const [dialog, setDialog] = useState<{ editing?: LabelWithCount; key: number } | null>(null);
	const [deleting, setDeleting] = useState<LabelWithCount | null>(null);

	const parents = useMemo(() => {
		const paths = new Set<string>();
		for (const l of labels) {
			const parts = l.name.split("/");
			for (let i = 1; i <= parts.length; i++) paths.add(parts.slice(0, i).join("/"));
		}
		return [...paths].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }));
	}, [labels]);

	const toggle = (path: string) =>
		setCollapsedPaths((prev) => {
			const next = new Set(prev);
			if (next.has(path)) next.delete(path);
			else next.add(path);
			return next;
		});

	const confirmDelete = async () => {
		const label = deleting;
		if (!label) return;
		setDeleting(null);
		try {
			await deleteLabel.mutateAsync({ mailboxId, labelId: label.id });
			toast(`Label "${label.name}" deleted.`);
			if (label.id === activeLabelId) navigate(folderPath(mailboxId, "inbox"));
		} catch {
			toast.error("Couldn't delete the label. Try again.");
		}
	};

	if (collapsed) {
		if (tree.length === 0) return null;
		return (
			<div className="mt-3 space-y-0.5 border-t border-sidebar-border pt-3">
				{tree.map((node) => {
					const target = firstLabel(node);
					if (!target) return null;
					const unread = node.label?.unreadCount ?? 0;
					return (
						<Tooltip key={node.path}>
							<TooltipTrigger
								render={
									<NavLink
										to={labelPath(mailboxId, target.id)}
										onClick={onNavigate}
										aria-label={node.path}
										className={({ isActive }) =>
											cn(
												"relative mx-auto flex h-8 w-12 items-center justify-center rounded-full text-sidebar-foreground/80 transition-colors outline-none hover:bg-sidebar-accent/60 hover:text-sidebar-foreground focus-visible:ring-2 focus-visible:ring-sidebar-ring",
												(isActive || node.children.some((c) => firstLabel(c)?.id === activeLabelId)) &&
													"bg-sidebar-accent text-sidebar-accent-foreground",
											)
										}
									>
										<Tag className={cn("size-4 bg-transparent!", `tag-chip-${(node.label ?? target).color}`)} />
										{unread > 0 && <span className="absolute top-1.5 right-3 size-2 rounded-full bg-primary" aria-hidden />}
									</NavLink>
								}
							/>
							<TooltipContent side="right">
								{node.path}
								{unread > 0 ? ` (${unread})` : ""}
							</TooltipContent>
						</Tooltip>
					);
				})}
			</div>
		);
	}

	return (
		<>
			<Collapsible open={sectionOpen} onOpenChange={setSectionOpen} className="mt-4">
				<div className="flex h-8 items-center justify-between pr-1 pl-4">
					<CollapsibleTrigger className="group/labels flex items-center gap-1 text-sm font-medium text-sidebar-foreground outline-none focus-visible:underline">
						Labels
						<ChevronRight className="size-3.5 text-muted-foreground transition-transform group-data-[panel-open]/labels:rotate-90" />
					</CollapsibleTrigger>
					<Tooltip>
						<TooltipTrigger
							render={
								<Button variant="ghost" size="icon-sm" aria-label="New label" onClick={() => setDialog({ key: Date.now() })}>
									<Plus />
								</Button>
							}
						/>
						<TooltipContent side="right">New label</TooltipContent>
					</Tooltip>
				</div>
				<CollapsibleContent>
					{tree.length > 0 ? (
						<ul className="space-y-0.5">
							{tree.map((node) => (
								<LabelRow
									key={node.path}
									node={node}
									depth={0}
									mailboxId={mailboxId}
									activeLabelId={activeLabelId}
									collapsedPaths={collapsedPaths}
									onToggle={toggle}
									onEdit={(label) => setDialog({ editing: label, key: Date.now() })}
									onDelete={setDeleting}
									onNavigate={onNavigate}
								/>
							))}
						</ul>
					) : (
						<p className="py-1 pl-4 text-xs text-muted-foreground">No labels yet</p>
					)}
				</CollapsibleContent>
			</Collapsible>

			{dialog && (
				<LabelDialog
					key={dialog.key}
					mailboxId={mailboxId}
					open
					onOpenChange={(next) => !next && setDialog(null)}
					editing={dialog.editing}
					parents={parents}
				/>
			)}

			<AlertDialog open={deleting !== null} onOpenChange={(next) => !next && setDeleting(null)}>
				<AlertDialogContent>
					<AlertDialogHeader>
						<AlertDialogTitle>Delete the label "{deleting?.name}"?</AlertDialogTitle>
						<AlertDialogDescription>Conversations keep their mail; only the label is removed.</AlertDialogDescription>
					</AlertDialogHeader>
					<AlertDialogFooter>
						<AlertDialogCancel>Cancel</AlertDialogCancel>
						<AlertDialogAction variant="destructive" onClick={() => void confirmDelete()}>
							Delete
						</AlertDialogAction>
					</AlertDialogFooter>
				</AlertDialogContent>
			</AlertDialog>
		</>
	);
}
