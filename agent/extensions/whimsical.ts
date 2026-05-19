import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

const messages = [
	"Thinking...",
	"Working...",
	"Checking the edges...",
	"Reading the room...",
	"Untangling the thread...",
	"Polishing the diff...",
	"Asking the electrons...",
	"Bribing the compiler...",
	"Whispering to the bits...",
	"Consulting the rubber duck...",
	"Interrogating the stack trace...",
	"Convincing the pixels to cooperate...",
	"Reticulating splines...",
	"Scrying the codebase...",
	"Taming wild pointers...",
	"Dancing with dependencies...",
	"Manifesting solutions...",
	"Charging the crystals...",
	"Aligning the chakras...",
	"Having a little think...",
	"Channeling Frieren's patience...",
	"Letting Maomao investigate...",
	"Borrowing Yor's precision...",
	"Debugging at Hashira speed...",
	"Asking Senku to science it...",
	"Waiting for Bocchi to unfreeze...",
	"Going Plus Ultra on the bug...",
	"Letting L calculate the edge cases...",
	"Summoning a tiny shikigami...",
	"Searching for the One Piece of context...",
];

function pickRandom(): string {
	return messages[Math.floor(Math.random() * messages.length)]!;
}

export default function (pi: ExtensionAPI) {
	pi.on("turn_start", async (_event, ctx) => {
		// Keep Pi's default working text one out of four turns.
		if (Math.random() < 0.75) ctx.ui.setWorkingMessage(pickRandom());
	});

	pi.on("turn_end", async (_event, ctx) => {
		ctx.ui.setWorkingMessage();
	});
}
