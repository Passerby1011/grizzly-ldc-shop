"use client";

import { useMemo } from "react";

/**
 * 可搜索的单选列表。
 *
 * 为什么不用原生 `<select size=N>`：列表一长（国家 206、服务 2488）就要滚动，
 * 选中项容易滚出视野；被搜索过滤后更是完全看不到自己选了啥。
 * 原生 select 又没法把选中项钉在顶部。
 *
 * 这里的关键行为：
 *   1. 选中项**永远置顶**并带 ✓ 与高亮 —— 无论列表多长、怎么过滤
 *   2. 顶部一行"已选"摘要，关掉列表也能确认
 *   3. 搜索无结果时明确提示，而不是给个空白框
 */

export interface ChoiceOption {
  value: string;
  label: string;
  /** 常用项打"常用"角标。 */
  pinned?: boolean;
}

interface Props {
  id?: string;
  /** 已选值；空字符串表示未选。 */
  value: string;
  options: ChoiceOption[];
  onSelect: (value: string) => void;
  /** 未选时的占位文案。 */
  placeholder?: string;
  /** 列表可见高度（行数）。 */
  rows?: number;
  /** 列表底部说明（数量等）。 */
  footer?: string;
}

export function SearchablePicker({
  id,
  value,
  options,
  onSelect,
  placeholder = "未选择",
  rows = 8,
  footer,
}: Props) {
  const selected = useMemo(() => options.find((o) => o.value === value), [options, value]);

  /* 选中项置顶；其余常用项次之，保持传入顺序（服务端已排好） */
  const ordered = useMemo(() => {
    if (!value) return options;
    const hit = options.filter((o) => o.value === value);
    const rest = options.filter((o) => o.value !== value);
    return [...hit, ...rest];
  }, [options, value]);

  return (
    <div>
      {/* 已选摘要：关掉列表也能一眼看到选了什么 */}
      <div
        className="mb-2 flex items-center gap-2 rounded-lg px-3 py-2 text-sm"
        style={{
          background: selected ? "rgb(var(--brand) / 0.09)" : "rgb(var(--surface-2))",
          border: `1px solid ${selected ? "rgb(var(--brand) / 0.35)" : "rgb(var(--line) / var(--line-a))"}`,
        }}
      >
        <span className="faint shrink-0 text-xs">已选</span>
        {selected ? (
          <span
            className="flex min-w-0 items-center gap-1.5 font-medium"
            style={{ color: "rgb(var(--brand))" }}
          >
            <Check />
            <span className="truncate">{selected.label}</span>
          </span>
        ) : (
          <span className="faint truncate">{placeholder}</span>
        )}
      </div>

      <div
        id={id}
        role="listbox"
        aria-label={placeholder}
        className="overflow-y-auto rounded-lg"
        style={{
          border: "1px solid rgb(var(--line) / var(--line-a))",
          maxHeight: `calc(${rows} * 2.1rem)`,
        }}
      >
        {ordered.length === 0 ? (
          <p className="faint px-3 py-4 text-center text-xs">没有匹配项，试试其它关键词</p>
        ) : (
          ordered.map((o) => {
            const isSel = o.value === value;
            return (
              <button
                key={o.value}
                type="button"
                role="option"
                aria-selected={isSel}
                onClick={() => onSelect(o.value)}
                className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm"
                style={{
                  background: isSel ? "rgb(var(--brand) / 0.12)" : "transparent",
                  color: isSel ? "rgb(var(--brand))" : "rgb(var(--fg))",
                  fontWeight: isSel ? 600 : 400,
                  borderBottom: "1px solid rgb(var(--line) / 0.05)",
                  /* 选中行钉在顶部时加个下边界，视觉上与其他行分开 */
                  boxShadow: isSel ? "inset 0 -1px 0 0 rgb(var(--brand) / 0.25)" : undefined,
                }}
              >
                <span className="w-4 shrink-0">{isSel ? <Check /> : null}</span>
                <span className="truncate">{o.label}</span>
                {o.pinned && !isSel ? <span className="faint ml-auto shrink-0 text-[10px]">常用</span> : null}
              </button>
            );
          })
        )}
      </div>

      {footer ? <p className="faint mt-1 text-xs">{footer}</p> : null}
    </div>
  );
}

function Check() {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true" className="shrink-0">
      <path
        d="M3 8.5l3.2 3.2L13 5"
        stroke="currentColor"
        strokeWidth="2.2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
