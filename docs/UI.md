# OpenMail UI

OpenMail's interface behaves like Gmail (layout, flows, keyboard) and looks like the other Every App apps (OpenSEO, OpenCRM): their shadcn kit on Base UI, lucide icons, sonner toasts and OpenSEO's theme tokens. It does not copy Gmail's visual styling (colors, Google Sans, pill shapes); where the two pull apart, the Every App look wins and the Gmail behavior stays.

## Kit

- `app/components/ui/*`: shadcn `base-nova` components copied from OpenCRM (`src/client/components/ui`), built on `@base-ui/react`, not Radix. Compose with the `render` prop, not `asChild`. Don't hand-edit them beyond the import paths; add a missing one from OpenCRM or OpenSEO, or with the `shadcn` CLI (`components.json`).
- `cn` from `~/lib/cn` (OpenCRM's `cn` package equivalent). Icons: `lucide-react` only. Toasts: `toast` from `sonner`, `<Toaster />` mounted once in `app/root.tsx`, bottom-left.
- Theme: `app/index.css` carries OpenSEO's tokens (`--background`, `--card`, `--primary`, `--sidebar`, ...), light and dark (`data-theme="light" | "dark"` on `<html>`, set by `app/lib/theme.ts`). Use the semantic classes (`bg-background`, `bg-card`, `text-muted-foreground`, `border-border`, `bg-sidebar`, `bg-primary`), never raw palette colors, except for status tones (`text-warning`, `text-destructive`, `text-success`, `text-info`).
- No `@cloudflare/kumo`, no `@phosphor-icons/react` once the overhaul lands.

- Theme follows the system by default, with Light / Dark / System in the account menu (OpenCRM's `ThemePreferenceMenuItems`), stored in `localStorage` and applied before paint (no flash).

## Layout (Gmail's frame)

```
┌───────────────────────────────────────────────────────────────────┐
│ ☰  OpenMail ▾(mailbox switcher)   [ 🔍 Search mail         ⚙︎ ]  🤖 ⚙ (me) │  top bar, full width
├───────────┬───────────────────────────────────────────────────────┤
│ [Compose] │ ☐▾ ⟳ ⋮                                 1–25 of 312 ‹ › │
│ Inbox  3  │───────────────────────────────────────────────────────│
│ Starred   │ ☐ ☆ Sender (3)  Subject - snippet…            4:12 PM │
│ Sent      │ ☐ ☆ Sender      [Draft] Subject - …            Oct 28 │
│ Drafts 12 │   (hover: 🗄 🗑 ✉ replace the date)                     │
│ Archive   │                                                       │
│ Spam      │                                                       │
│ Trash     │                                                       │
│ Folders + │                                                       │
└───────────┴───────────────────────────────────────────────────────┘
                       ┌ New message ─ ⤢ ✕┐ ┌ 🤖 Agent        ─ ⤢ ✕┐
                       │ floating compose  │ │ floating agent window │
                       └───────────────────┘ └───────────────────────┘
```

- **Top bar** (`app/components/TopBar.tsx`): menu button collapses the sidebar to an icon rail (desktop) or opens it as a sheet (mobile); the mailbox name with a dropdown to switch mailboxes or go to "All mailboxes"; a wide search field in the middle (`/` focuses it, Enter searches, the existing search syntax still works); on the right the agent button (opens the agent window, or minimizes it when it's open), settings, and the person's avatar/email (from `/api/v1/me`) with Sign out (opens the gateway).
- **Sidebar** (`app/components/Sidebar.tsx`): a large Compose button on top, then Inbox, Starred (a virtual view: search `is:starred`), Sent, Drafts, Archive, Spam, Trash with unread counts (Drafts shows its total), then "Folders" with `+` for custom folders. Active item is filled with `bg-sidebar-accent`. Collapsed: icons only, with tooltips and a dot for unread.
- **Main**: one pane, not a split. The list fills it; opening a conversation replaces the list (Gmail's default). The URL names the conversation: `/mailbox/:mailboxId/emails/:folder/:emailId`, so back/forward and reload work.
- **Agent** (`app/components/AgentWindow.tsx`): a floating window like compose but larger (720px wide, nearly full height), the rightmost window at the bottom right. Its header has the Agent and AI clients tabs, Clear chat, minimize (to an "Agent" bar), expand (a centered window, about 1100px wide, with a backdrop; Escape restores) and close. Clicking the header's empty space minimizes or restores it. A first visit shows the minimized bar; open/minimized is remembered in `localStorage`, expanded never is. The chat stays mounted while minimized. On mobile it is full screen and minimizing hides it; the top bar's button brings it back.
- **Compose**: a floating window docked bottom-right (`app/components/ComposeWindow.tsx`), left of the agent window or its bar when both fit (else over it): header with title ("New message" or the subject), minimize (collapses to the header bar), expand (centered dialog-sized), close (saves a draft if anything was typed, toast "Draft saved"). Replies and forwards open inline at the bottom of the conversation instead, like Gmail.

## List (`app/routes/email-list.tsx`)

- Toolbar: select-all checkbox with a menu (All, None, Read, Unread, Starred, Unstarred), refresh, a "more" menu (Mark all as read); right side "1–25 of N" with previous/next page buttons. With rows selected the toolbar switches to bulk actions: Archive, Report spam / Not spam, Delete (Trash; Delete forever inside Trash), Mark read/unread, Move to ▾.
- Rows: dense single line on desktop: checkbox, star, sender(s) with thread count, Draft label in destructive color when the thread has a draft, subject in bold when unread, " - " snippet muted, attachment chips under it only when the API says there are attachments, date on the right. Unread rows have `font-semibold` and a `bg-card` background; read rows `bg-muted/40`. On hover the date is replaced by Archive, Delete, Mark read/unread, (Gmail's snooze has no backend: leave it out). Selected rows are tinted `bg-primary/10`. Two-line layout on mobile.
- Archive, Delete, Move, Spam act at once and show a sonner toast ("Conversation archived." with Undo), Undo moves it back to the folder it came from. Only "Delete forever" (in Trash) asks for confirmation (AlertDialog).
- Empty folders keep the current helpful copy (the Inbox one names the mailbox address).

## Conversation (`app/components/EmailPanel.tsx` and `app/components/email-panel/*`)

- Toolbar: back to list (← and `u`), Archive, Report spam, Delete, Mark unread, Move to ▾, more (Show original); right side "3 of 25" with older/newer arrows.
- Subject as a large heading with the folder badge. Messages oldest first like Gmail (collapsed to one line each except the newest and unread ones; "N older messages" collapses a long middle). Each expanded message: avatar initial, sender name and address, "to me", date, star, Reply and more menu (Reply, Reply all, Forward, Show original, Delete this message).
- The agent's draft in the thread shows as a draft card with Edit and Send and Discard.
- At the bottom: Reply, Reply all, Forward buttons that open the inline composer in place.

## Keyboard (Gmail's)

`c` compose, `/` search, `j`/`k` next/previous conversation (in the list moves the focus ring, in a conversation opens the next/previous), `o`/Enter open, `u` back to list, `e` archive, `#` delete, `!` spam, `s` star, `x` select, `r` reply, `a` reply all, `f` forward, `Shift+i` mark read, `Shift+u` mark unread, `g` then `i`/`s`/`d`/`t` go to Inbox/Sent/Drafts/Trash, `?` shows the shortcut sheet. Ignored while typing in an input, textarea or the editor. One hook: `app/hooks/useHotkeys.ts`.

## Labels

Gmail's labels, for real: a conversation can carry several. Folders stay (Inbox, Sent, Drafts, Archive, Spam, Trash and custom folders: where a message *is*); labels are tags on top.

- Storage: two tables in each mailbox's Durable Object, `labels (id, name UNIQUE, color)` and `email_labels (email_id, label_id)`, added by the port's own migrations in a `MailboxDO` subclass (`workers/everyapp/mailbox.ts`), so upstream's `workers/durableObject/*` and `workers/db/*` stay byte-identical. A conversation's labels are the union of its messages' labels; labeling a conversation labels every message in it.
- Names may contain `/` for nesting (`Work/Reports`); the sidebar shows them as a tree, collapsible, and the list shows the full name. Colors come from a fixed palette of eight (OpenCRM's tag-chip tones: slate, rose, amber, lime, emerald, sky, violet, fuchsia).
- API: `GET/POST /api/v1/mailboxes/:id/labels`, `PUT/DELETE .../labels/:labelId`, `POST .../threads/:threadId/labels` (`{ add: string[], remove: string[] }`, label ids), the list and thread responses carry `labels: { id, name, color }[]` per conversation, `GET .../emails?label=<id>` lists a label's conversations. Search understands `label:<name>`.
- MCP: `list_labels`, `create_label`, `label_conversation` (add and remove), risk `write` for the writes.
- UI: chips before the subject in the list and next to the subject in the conversation (with an × to remove); "Label as ▾" in the list's bulk toolbar and the conversation toolbar (a checkbox menu with search and "Create new"); `l` opens it; the sidebar's "Labels" section with `+` and each label's menu (Edit, Color, Delete); `/mailbox/:mailboxId/labels/:labelId` lists a label's conversations.

## Other pages

- Home (`/`): the mailbox chooser, as cards or a table in the kit, with Create mailbox for owners and admins, and the sending-off banner.
- Settings, Search results, Not found: in the kit, inside the same frame. Search results reuse the list rows.
