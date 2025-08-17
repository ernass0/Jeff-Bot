# AI commands
# Format is simple: list actions. The AI must respond with JSON describing file operations.
# Example commands:
create: ai-workspace/hello.txt
content:
Hello from AI!

update: README.md
content:
# Updated README
This repo was updated by the AI.

delete: old-stuff/obsolete.txt

# Or ask the AI to "clean up AI workspace"
action: clean_workspace
