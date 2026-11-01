// The MCP servers offered with one click. Granola is the one Captain's main
// web product ships (OAuth 2.1 with dynamic client registration and PKCE);
// Notion and Linear run official remote MCP servers that sign in the same
// way. Anything else is added by its URL.

export type McpPreset = {id: string; name: string; url: string; description: string; hosts: RegExp};

export const MCP_PRESETS: McpPreset[] = [
    {id: 'granola', name: 'Granola', url: 'https://mcp.granola.ai/mcp', description: 'Your meeting notes and transcripts', hosts: /(^|\.)granola\.ai$/i},
    {id: 'notion', name: 'Notion', url: 'https://mcp.notion.com/mcp', description: 'Pages and databases in your Notion', hosts: /(^|\.)notion\.com$/i},
    {id: 'linear', name: 'Linear', url: 'https://mcp.linear.app/mcp', description: 'Issues, projects and cycles in Linear', hosts: /(^|\.)linear\.app$/i},
];

export function presetFor(url: string): McpPreset | undefined {
    try {
        const host = new URL(url).hostname;
        return MCP_PRESETS.find((p) => p.hosts.test(host));
    } catch {
        return undefined;
    }
}
