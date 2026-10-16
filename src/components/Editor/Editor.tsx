import type { NoteData } from '../../shared/types'

type EditorProps = {
	selectedNote: NoteData | null
	loading: boolean
	error: string | null
}

export default function Editor({ selectedNote, loading, error }: EditorProps) {
	return (
		<main className="bg-black my-4 m-4 h-[calc(100vh-2rem)] min-w-0 flex-1 rounded-3xl" data-note-path={selectedNote?.path} data-note-loading={loading} data-note-error={error ?? undefined}>
			<div>
			</div>
		</main>
	)

}
