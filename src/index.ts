import { McpAgent } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { dump } from "js-yaml";
import "dotenv"
import { FigmaService } from "./services/figma";
import type { SimplifiedDesign } from "./services/simplify-node-response";

interface Env {
	FIGMA_API_KEY: string;
}

let _figmaService: FigmaService;

function getFigmaService(key: string) {
	if (!_figmaService) {
		if (!key) {
			throw new Error("FIGMA_API_KEY is not set");
		}
		_figmaService = new FigmaService(key);
	}
	return _figmaService;
}

// Define our MCP agent with tools
export class FigmaMcp extends McpAgent<Env> {
	server = new McpServer({
		name: "Figma MCP",
		version: "1.0.0",
		description: "A MCP agent for Figma",
	});

	figmaService = getFigmaService(this.env.FIGMA_API_KEY);

	async init() {
		// Tool to get file information
		this.server.tool(
			"get_figma_data",
			"When the nodeId cannot be obtained, obtain the layout information about the entire Figma file",
			{
				fileKey: z
					.string()
					.describe(
						"The key of the Figma file to fetch, often found in a provided URL like figma.com/(file|design)/<fileKey>/...",
					),
				nodeId: z
					.string()
					.optional()
					.describe(
						"The ID of the node to fetch, often found as URL parameter node-id=<nodeId>, always use if provided",
					),
				depth: z
					.number()
					.optional()
					.describe(
						"How many levels deep to traverse the node tree, only use if explicitly requested by the user",
					),
			},
			async ({ fileKey, nodeId, depth }) => {
				try {
					console.log(
						`Fetching ${
							depth ? `${depth} layers deep` : "all layers"
						} of ${nodeId ? `node ${nodeId} from file` : `full file`} ${fileKey}`,
					);
	
					let file: SimplifiedDesign;
					if (nodeId) {
						file = await this.figmaService.getNode(fileKey, nodeId, depth);
					} else {
						file = await this.figmaService.getFile(fileKey, depth);
					}
	
					console.log(`Successfully fetched file: ${file.name}`);
					const { nodes, globalVars, ...metadata } = file;
	
					const result = {
						metadata,
						nodes,
						globalVars,
					};
	
					console.log("Generating YAML result from file");
					const yamlResult = dump(result);
	
					console.log("Sending result to client");
					return {
						content: [{ type: "text", text: yamlResult }],
					};
				} catch (error) {
					const message = error instanceof Error ? error.message : JSON.stringify(error);
					console.error(`Error fetching file ${fileKey}:`, message);
					return {
						isError: true,
						content: [{ type: "text", text: `Error fetching file: ${message}` }],
					};
				}
			},
		);
	
		// TODO: Clean up all image download related code, particularly getImages in Figma service
		// Tool to download images
		this.server.tool(
			"download_figma_images",
			"Download SVG and PNG images used in a Figma file based on the IDs of image or icon nodes",
			{
				fileKey: z.string().describe("The key of the Figma file containing the node"),
				nodes: z
					.object({
						nodeId: z
							.string()
							.describe("The ID of the Figma image node to fetch, formatted as 1234:5678"),
						imageRef: z
							.string()
							.optional()
							.describe(
								"If a node has an imageRef fill, you must include this variable. Leave blank when downloading Vector SVG images.",
							),
						fileName: z.string().describe("The local name for saving the fetched file"),
					})
					.array()
					.describe("The nodes to fetch as images"),
				localPath: z
					.string()
					.describe(
						"The absolute path to the directory where images are stored in the project. If the directory does not exist, it will be created. The format of this path should respect the directory format of the operating system you are running on. Don't use any special character escaping in the path name either.",
					),
			},
			async ({ fileKey, nodes, localPath }) => {
				try {
					const imageFills = nodes.filter(({ imageRef }) => !!imageRef) as {
						nodeId: string;
						imageRef: string;
						fileName: string;
					}[];
					const fillDownloads = this.figmaService.getImageFills(fileKey, imageFills, localPath);
					const renderRequests = nodes
						.filter(({ imageRef }) => !imageRef)
						.map(({ nodeId, fileName }) => ({
							nodeId,
							fileName,
							fileType: fileName.endsWith(".svg") ? ("svg" as const) : ("png" as const),
						}));

					const renderDownloads = this.figmaService.getImages(fileKey, renderRequests, localPath);

					const downloads = await Promise.all([fillDownloads, renderDownloads]).then(([f, r]) => [
						...f,
						...r,
					]);
	
					// If any download fails, return false
					const saveSuccess = !downloads.find((success) => !success);
					return {
						content: [
							{
								type: "text",
								text: saveSuccess
									? `Success, ${downloads.length} images downloaded: ${downloads.join(", ")}`
									: "Failed",
							},
						],
					};
				} catch (error) {
					console.error(`Error downloading images from file ${fileKey}:`, error);
					return {
						isError: true,
						content: [{ type: "text", text: `Error downloading images: ${error}` }],
					};
				}
			},
		);
	}
}

export default {
	fetch(request: Request, env: Env, ctx: ExecutionContext) {
		const url = new URL(request.url);

		if (url.pathname === "/sse" || url.pathname === "/sse/message") {
			// @ts-ignore
			return FigmaMcp.serveSSE("/sse").fetch(request, env, ctx);
		}

		if (url.pathname === "/mcp") {
			// @ts-ignore
			return FigmaMcp.serve("/mcp").fetch(request, env, ctx);
		}

		return new Response("Not found", { status: 404 });
	},
};
