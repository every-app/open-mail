// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { Color } from "@tiptap/extension-color";
import Highlight from "@tiptap/extension-highlight";
import TiptapImage from "@tiptap/extension-image";
import LinkExtension from "@tiptap/extension-link";
import TextAlign from "@tiptap/extension-text-align";
import { TextStyle } from "@tiptap/extension-text-style";
import Underline from "@tiptap/extension-underline";
import { type Editor, EditorContent, useEditor, useEditorState } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import {
	Bold,
	Italic,
	Link2,
	Link2Off,
	List,
	ListOrdered,
	Minus,
	Quote,
	Redo2,
	Strikethrough,
	Underline as UnderlineIcon,
	Undo2,
} from "lucide-react";
import { type ReactElement, type ReactNode, useCallback, useEffect } from "react";
import { Button } from "~/components/ui/button";
import { Separator } from "~/components/ui/separator";
import { Toggle } from "~/components/ui/toggle";
import { Tooltip, TooltipContent, TooltipTrigger } from "~/components/ui/tooltip";
import { cn } from "~/lib/cn";

interface RichTextEditorProps {
	value: string;
	onChange: (value: string) => void;
	/** Shows the formatting bar (default true); Gmail's "A" button toggles it. */
	showToolbar?: boolean;
	/** Where the formatting bar sits (default "top"). */
	toolbarPosition?: "top" | "bottom";
	/** Draws the editor's own rounded border (default true). */
	bordered?: boolean;
	/** Focuses the start of the text when `value` is replaced from outside (default true). */
	focusOnReplace?: boolean;
	className?: string;
}

/** Message body text: the theme's tokens, no typography plugin. */
const CONTENT_CLASS = cn(
	"min-h-[180px] px-3 py-2.5 text-sm leading-relaxed text-foreground focus:outline-none",
	"[&_p]:my-0 [&_p:empty]:min-h-[1lh] [&_a]:text-primary [&_a]:underline [&_a]:underline-offset-2",
	"[&_blockquote]:my-2 [&_blockquote]:border-l-2 [&_blockquote]:border-border [&_blockquote]:pl-3 [&_blockquote]:text-muted-foreground",
	"[&_hr]:my-3 [&_hr]:border-border [&_img]:max-w-full [&_h1]:text-xl [&_h1]:font-semibold [&_h2]:text-lg [&_h2]:font-semibold [&_h3]:font-semibold",
	"[&_code]:rounded [&_code]:bg-muted [&_code]:px-1 [&_code]:font-mono [&_code]:text-[0.85em]",
);

function ToolbarTooltip({ label, children }: { label: string; children: ReactElement }) {
	return (
		<Tooltip>
			<TooltipTrigger render={children} />
			<TooltipContent side="top">{label}</TooltipContent>
		</Tooltip>
	);
}

function MarkToggle({
	label,
	pressed,
	onToggle,
	children,
}: {
	label: string;
	pressed: boolean;
	onToggle: () => void;
	children: ReactNode;
}) {
	return (
		<ToolbarTooltip label={label}>
			<Toggle size="sm" className="px-0" aria-label={label} pressed={pressed} onPressedChange={onToggle}>
				{children}
			</Toggle>
		</ToolbarTooltip>
	);
}

function ToolbarButton({
	label,
	onClick,
	disabled,
	children,
}: {
	label: string;
	onClick: () => void;
	disabled?: boolean;
	children: ReactNode;
}) {
	return (
		<ToolbarTooltip label={label}>
			<Button type="button" variant="ghost" size="icon-sm" aria-label={label} onClick={onClick} disabled={disabled}>
				{children}
			</Button>
		</ToolbarTooltip>
	);
}

function Toolbar({ editor, setLink, className }: { editor: Editor; setLink: () => void; className?: string }) {
	// TipTap 3 doesn't re-render on every transaction: subscribe to what the bar shows.
	const state = useEditorState({
		editor,
		selector: ({ editor: e }) => ({
			bold: e.isActive("bold"),
			italic: e.isActive("italic"),
			underline: e.isActive("underline"),
			strike: e.isActive("strike"),
			bulletList: e.isActive("bulletList"),
			orderedList: e.isActive("orderedList"),
			blockquote: e.isActive("blockquote"),
			link: e.isActive("link"),
			canUndo: e.can().undo(),
			canRedo: e.can().redo(),
		}),
	});
	const chain = () => editor.chain().focus();

	return (
		<div role="toolbar" aria-label="Formatting" className={cn("flex shrink-0 flex-wrap items-center gap-0.5 px-1.5 py-1", className)}>
			<ToolbarButton label="Undo" onClick={() => chain().undo().run()} disabled={!state.canUndo}>
				<Undo2 />
			</ToolbarButton>
			<ToolbarButton label="Redo" onClick={() => chain().redo().run()} disabled={!state.canRedo}>
				<Redo2 />
			</ToolbarButton>

			<Separator orientation="vertical" className="mx-1 my-1.5" />

			<MarkToggle label="Bold" pressed={state.bold} onToggle={() => chain().toggleBold().run()}>
				<Bold />
			</MarkToggle>
			<MarkToggle label="Italic" pressed={state.italic} onToggle={() => chain().toggleItalic().run()}>
				<Italic />
			</MarkToggle>
			<MarkToggle label="Underline" pressed={state.underline} onToggle={() => chain().toggleUnderline().run()}>
				<UnderlineIcon />
			</MarkToggle>
			<MarkToggle label="Strikethrough" pressed={state.strike} onToggle={() => chain().toggleStrike().run()}>
				<Strikethrough />
			</MarkToggle>

			<Separator orientation="vertical" className="mx-1 my-1.5" />

			<MarkToggle label="Bulleted list" pressed={state.bulletList} onToggle={() => chain().toggleBulletList().run()}>
				<List />
			</MarkToggle>
			<MarkToggle label="Numbered list" pressed={state.orderedList} onToggle={() => chain().toggleOrderedList().run()}>
				<ListOrdered />
			</MarkToggle>
			<MarkToggle label="Quote" pressed={state.blockquote} onToggle={() => chain().toggleBlockquote().run()}>
				<Quote />
			</MarkToggle>

			<Separator orientation="vertical" className="mx-1 my-1.5" />

			<MarkToggle label={state.link ? "Edit link" : "Insert link"} pressed={state.link} onToggle={setLink}>
				<Link2 />
			</MarkToggle>
			{state.link && (
				<ToolbarButton label="Remove link" onClick={() => chain().unsetLink().run()}>
					<Link2Off />
				</ToolbarButton>
			)}
			<ToolbarButton label="Horizontal line" onClick={() => chain().setHorizontalRule().run()}>
				<Minus />
			</ToolbarButton>
		</div>
	);
}

export default function RichTextEditor({
	value,
	onChange,
	showToolbar = true,
	toolbarPosition = "top",
	bordered = true,
	focusOnReplace = true,
	className,
}: RichTextEditorProps) {
	const editor = useEditor({
		extensions: [
			// StarterKit 3 bundles Link and Underline; ours are configured below.
			StarterKit.configure({ link: false, underline: false }),
			Underline,
			TextAlign.configure({ types: ["heading", "paragraph"] }),
			LinkExtension.configure({ openOnClick: false }),
			TiptapImage,
			TextStyle,
			Color,
			Highlight.configure({ multicolor: true }),
		],
		content: value,
		editorProps: {
			attributes: {
				class: CONTENT_CLASS,
				"aria-label": "Message body",
			},
		},
		onUpdate: ({ editor }) => {
			onChange(editor.getHTML());
		},
	});

	useEffect(() => {
		if (editor && !editor.isDestroyed && value !== editor.getHTML()) {
			editor.commands.setContent(value);
			if (!focusOnReplace) return;
			// Place cursor at the start of the document (above quoted text)
			const rafId = requestAnimationFrame(() => {
				if (!editor.isDestroyed) {
					editor.commands.focus("start");
				}
			});
			return () => cancelAnimationFrame(rafId);
		}
	}, [value, editor, focusOnReplace]);

	const setLink = useCallback(() => {
		if (!editor) return;
		const previousUrl = editor.getAttributes("link").href;
		const url = window.prompt("URL", previousUrl);
		if (url === null) return;
		if (url === "") {
			editor.chain().focus().extendMarkRange("link").unsetLink().run();
			return;
		}
		editor.chain().focus().extendMarkRange("link").setLink({ href: url }).run();
	}, [editor]);

	if (!editor) return null;

	const toolbar = showToolbar ? (
		<Toolbar
			editor={editor}
			setLink={setLink}
			className={cn(
				toolbarPosition === "top" && bordered && "border-b border-border bg-muted/40",
				toolbarPosition === "bottom" && "mx-2 mb-1 rounded-lg bg-muted/60",
			)}
		/>
	) : null;

	return (
		<div
			className={cn(
				"flex h-full min-h-0 flex-col overflow-hidden",
				bordered && "rounded-lg border border-border bg-card",
				className,
			)}
		>
			{toolbarPosition === "top" && toolbar}
			<div className="min-h-0 flex-1 cursor-text overflow-y-auto" onClick={() => editor.commands.focus()}>
				<EditorContent editor={editor} className="h-full [&>.ProseMirror]:min-h-full" />
			</div>
			{toolbarPosition === "bottom" && toolbar}
		</div>
	);
}
