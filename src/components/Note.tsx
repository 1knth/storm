import { useState } from 'react'
import { IoIosArrowForward } from 'react-icons/io'
import { FaFolder } from 'react-icons/fa'
import type { VaultEntry } from '../shared/types'

type NoteProps = {
	entry: VaultEntry
	entries: VaultEntry[]
	depth: number
	selectedId: string | null
	onNoteClick: (id: string) => void
}

export default function Note({ entry, entries, depth, selectedId, onNoteClick }: NoteProps) {
	const [expanded, setExpanded] = useState(false)
	const children = entries.filter(candidate => {
		const parent = candidate.path.split('\\').join('/').split('/').slice(0, -1).join('/')
		return parent === entry.path.split('\\').join('/').replace(/\/$/, '')
	})
	const isSelected = !entry.isDirectory && selectedId === entry.path
	return (
		<li>
			{entry.isDirectory ? (
				<>
					<button type="button" aria-expanded={expanded} onClick={() => setExpanded(!expanded)} style={{ paddingLeft: `${8 + depth * 16}px` }} className="flex w-full min-h-8 items-center justify-between rounded-md p-2 text-left text-white/90">
						<span className="flex min-w-0 items-center gap-2 truncate"><FaFolder />{entry.name}</span>
						<IoIosArrowForward className={`shrink-0 transition-transform ${expanded ? 'rotate-90' : ''}`} />
					</button>
					{expanded && children.length > 0 && <ul>{children.map(child => <Note key={child.path} entry={child} entries={entries} depth={depth + 1} selectedId={selectedId} onNoteClick={onNoteClick} />)}</ul>}
				</>
			) : (
				<button type="button" id={`note-${encodeURIComponent(entry.path)}`} aria-pressed={isSelected} onClick={() => onNoteClick(entry.path)} style={{ paddingLeft: `${16 + depth * 16}px` }} className={`flex min-h-14 w-full flex-col justify-center p-2 text-left outline-1 outline-white/15  ${isSelected ? 'bg-[#027DFF]/60 rounded-md outline-none' : ''}`}>
					<span className="truncate text-md font-medium text-white/90">
						{ entry.name.slice(0, entry.name.indexOf(".")) }
					</span>
					<span className="truncate text-sm font-light text-white/90"> {entry.peek} </span>
				</button>
			)}
		</li>
	)
}
