type ResumeOutputFollowingOptions = {
  pauseTracking: () => void;
  enableFollow: () => void;
  scrollToBottom: () => Promise<void> | undefined;
  resumeTracking: (options: { syncToBottom: boolean }) => void;
};

export async function resumeOutputFollowing(options: ResumeOutputFollowingOptions) {
  options.pauseTracking();
  options.enableFollow();
  try {
    await options.scrollToBottom();
  } finally {
    options.resumeTracking({ syncToBottom: true });
  }
}
