type Notification = {
	dismissed: boolean;
	remove?: () => void;
};

type SendNotification = (delivered: () => void) => () => void;

/** Session-local tracking: acknowledging an alert never resolves its permission request. */
export function createFocusNotifications(options: {
	isFocused: () => Promise<boolean>;
	intervalMs?: number;
	onError?: (error: unknown) => void;
}) {
	const pending = new Set<Notification>();
	let timer: ReturnType<typeof setInterval> | undefined;
	let checking: Promise<boolean> | undefined;
	let disposed = false;

	function remove(notification: Notification): void {
		try { notification.remove?.(); }
		catch (error) { options.onError?.(error); }
	}
	function dismiss(notification: Notification): void {
		if (notification.dismissed) return;
		notification.dismissed = true;
		pending.delete(notification);
		remove(notification);
		if (!pending.size && timer) { clearInterval(timer); timer = undefined; }
	}
	function dismissAll(): void {
		for (const notification of [...pending]) dismiss(notification);
	}
	function probe(): Promise<boolean> {
		if (!checking) {
			checking = Promise.resolve().then(() => disposed ? false : options.isFocused())
				.catch(() => false).finally(() => { checking = undefined; });
		}
		return checking;
	}
	return {
		show(send: SendNotification): () => void {
			if (disposed) return () => {};
			const notification: Notification = { dismissed: false };
			pending.add(notification);
			if (!timer) {
				timer = setInterval(() => {
					void probe().then(focused => { if (focused) dismissAll(); });
				}, options.intervalMs ?? 1000);
				timer.unref?.();
			}
			void probe().then(focused => {
				if (focused) dismissAll();
				if (notification.dismissed) return;
				try {
					notification.remove = send(() => {
						// Focus/approval may race the sender's asynchronous delivery.
						if (notification.dismissed) remove(notification);
					});
					if (notification.dismissed) remove(notification);
				} catch (error) {
					dismiss(notification);
					options.onError?.(error);
				}
			});
			return () => dismiss(notification);
		},
		dispose(): void { disposed = true; dismissAll(); },
	};
}
