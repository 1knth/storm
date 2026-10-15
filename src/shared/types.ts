declare global {
  interface Window {
    vault: {
      choose: () => Promise<string | null>;
    };
  }
}

export interface Note {
	id: string;
	title: string;
	content: {
		body: {}
	};
	updatedAt: string; // ISO date string
}
