export declare const name = "dsh-annotation";
/** 没有持久化数据时的默认标签（内置、不落盘）。 */
export declare const DEFAULT_TAGS: string[];
/** 浏览器端读写的路由（同源相对路径 /annotation-tags）。 */
export declare const ROUTE_PATH = "/annotation-tags";
type TagList = string[];
/** 标签 JSON 文件路径：config.tagsFile 显式优先，否则 DSH home 下的固定文件名。 */
export declare function resolveTagsFile(config: unknown): string;
/** 规整标签列表：去空白、去重、限长限量；非数组返回 null（= 没有持久化数据）。 */
export declare function normalizeTags(value: unknown): TagList | null;
/** 读标签文件：不存在 / 损坏时返回 null（调用方回落到内置默认，不创建文件）。 */
export declare function readTagsFile(file: string): TagList | null;
/** 写标签文件：回到默认列表时删除文件（默认标签不落盘），否则写可读 JSON。 */
export declare function writeTagsFile(file: string, tags: TagList): void;
export declare function apply(ctx: any, config: unknown): void;
declare const _default: {
    name: string;
    apply: typeof apply;
};
export default _default;
