Import the chats you exported from chat.deepseek.com into a workspace and keep talking to them.

Turn the plugin on in Plugins → More (experimental), then click the upload arrow beside New session, choose the `deepseek_data-*.zip` file and the workspace that should receive the chats, and press Import. The dialog shows the upload, then how many chats it has imported.

Each exported chat becomes one Session: the branch you were viewing, its original title and times, its reasoning, its web search and page cards, and its images. Replies that were withdrawn, failed, or answered by a template appear as an error row and stay out of the model context; a chat whose questions were all withdrawn is skipped.

Importing needs ZIP files only and works for the owner: a shared guest does not see the button. One import writes at most `maxSessions` chats (1000 by default), accepts at most `maxUploadBytes` (512 MiB) and at most `maxEntryBytes` (256 MiB) per archive entry, and truncates titles to `maxTitleBytes` (80). Importing the same file twice creates a second workspace copy of every chat.

The package README covers the failure reasons, the event mapping and the known limitations.
