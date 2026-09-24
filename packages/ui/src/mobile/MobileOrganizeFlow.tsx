/**
 * 智能整理两步流程（全屏）：① 选择规则（显示每条规则的命中数）→ ② 预览分组并确认。
 * 确认前不移动任何文件；落盘由 MobileApp 走 applyOrganize，完成后可在任务中心撤销。
 */
import { useMemo, useState } from 'react';
import type { FolderNode, ImageEntry, OrganizeBinding } from '../../../core/src/index';
import type { LibraryStore } from '../../../fs-adapter/src/types';
import type { CustomOrganizeRule } from '../../../organizer/src/index';
import { BlobImage } from '../BlobImage';
import { imageToFileRef } from './mobileCards';
import { MobileIcon, type MobileIconName } from './mobileIcons';
import { MobilePromptDialog } from './MobileSheets';
import {
  AUTO_RULE_ID,
  bindingsForRule,
  planBindings,
  previewGroups,
  renameGroup,
  ruleOptions,
  type PlannedBinding,
} from './organizePlan';
import { Z_SETTINGS } from './zindex';

const RULE_ICONS: Record<string, MobileIconName> = {
  [AUTO_RULE_ID]: 'wand',
  separator: 'folder',
  date: 'clock',
  author: 'tag',
  chapter: 'layers',
  pixiv: 'images',
  commonPrefix: 'sort',
};

/** 预览里一次渲染的分组上限（分组极多时避免一次挂载几千个缩略图）。 */
const GROUP_RENDER_LIMIT = 120;
const GROUP_THUMBS = 5;

export function MobileOrganizeFlow({
  folder,
  images,
  customRules,
  store,
  blurredPaths,
  step,
  onStepChange,
  onApply,
  onClose,
  onManageRules,
  exiting,
}: {
  folder: FolderNode;
  images: ImageEntry[];
  customRules: CustomOrganizeRule[];
  store: LibraryStore;
  blurredPaths: ReadonlySet<string>;
  step: 1 | 2;
  onStepChange: (step: 1 | 2) => void;
  onApply: (bindings: OrganizeBinding[], ruleName: string) => void;
  onClose: () => void;
  onManageRules: () => void;
  exiting: boolean;
}) {
  const planned = useMemo(() => planBindings(images, customRules), [images, customRules]);
  const options = useMemo(() => ruleOptions(planned, customRules), [planned, customRules]);
  const [ruleId, setRuleId] = useState(AUTO_RULE_ID);
  // 预览阶段对分组的改名在 overrides 上累积；回到第一步换规则时丢弃。
  const [edited, setEdited] = useState<{ ruleId: string; bindings: PlannedBinding[] } | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);

  const rule = options.find((o) => o.id === ruleId) ?? options[0]!;
  const selected = useMemo(() => bindingsForRule(planned, ruleId), [planned, ruleId]);
  const bindings = edited && edited.ruleId === ruleId ? edited.bindings : selected;
  const groups = useMemo(() => previewGroups(bindings), [bindings]);
  const moving = groups.reduce((s, g) => s + g.bindings.length, 0);
  const staying = images.length - moving;
  const imageById = useMemo(() => new Map(images.map((img) => [img.id, img])), [images]);
  const stayingImages = useMemo(() => {
    const moved = new Set(groups.flatMap((g) => g.bindings.map((b) => b.imageId)));
    return images.filter((img) => !moved.has(img.id));
  }, [groups, images]);

  const thumb = (img: ImageEntry | undefined) =>
    img ? (
      <BlobImage
        store={store}
        fileRef={imageToFileRef(img)}
        alt=""
        className="w-full h-full object-cover"
        thumbnail
        lazy
        blur={blurredPaths.has(img.relPath)}
      />
    ) : null;

  return (
    <div className={`m2-page fixed inset-0 flex flex-col ${exiting ? 'm-page-exit-right' : 'm-subpage-enter'}`} style={{ zIndex: Z_SETTINGS }}>
      <header className="m2-appbar is-solid" style={{ paddingTop: 'env(safe-area-inset-top, 0px)' }}>
        <div className="m2-appbar-row">
          <button className="m2-icon-button" onClick={() => (step === 2 ? onStepChange(1) : onClose())} aria-label={step === 2 ? '上一步' : '返回'}>
            <MobileIcon name="back" className="w-[22px] h-[22px]" />
          </button>
          <div className="m2-appbar-title is-visible">
            智能整理
            <small>{folder.name}</small>
          </div>
        </div>
      </header>

      <main className="m2-scroll flex-1 overflow-y-auto overscroll-contain" key={step}>
        <div className="m2-flow-head">
          <h1>{step === 1 ? '选择整理规则' : '预览整理结果'}</h1>
          <p>
            {step === 1
              ? '先生成预览；确认之前，不会移动任何文件。'
              : `在「${folder.name}」内按「${rule.name}」建立 ${groups.length} 个目录；完成后可在任务中心撤销。`}
          </p>
          <div className="m2-steps" aria-label={`第 ${step} 步，共 2 步`}>
            <i className="is-on" />
            <i className={step === 2 ? 'is-on' : ''} />
          </div>
        </div>

        {step === 1 ? (
          <div className="m2-rules" role="radiogroup" aria-label="整理规则">
            {options.map((o) => (
              <button
                key={`${o.kind}-${o.id}`}
                role="radio"
                aria-checked={o.id === ruleId}
                className={`m2-rule ${o.id === ruleId ? 'is-on' : ''} ${o.hitCount === 0 ? 'is-empty' : ''}`}
                onClick={() => {
                  setRuleId(o.id);
                  setEdited(null);
                }}
              >
                <span className="m2-rule-icon">
                  <MobileIcon name={RULE_ICONS[o.id] ?? 'braces'} className="w-5 h-5" />
                </span>
                <span className="m2-rule-copy">
                  <strong>
                    {o.name}
                    {o.kind === 'custom' && <em>自定义</em>}
                  </strong>
                  <small>{o.description}</small>
                </span>
                <span className="m2-rule-hit tabular-nums">{o.hitCount > 0 ? `命中 ${o.hitCount}` : '无命中'}</span>
              </button>
            ))}
            <button className="m2-rule is-link" onClick={onManageRules}>
              <span className="m2-rule-icon">
                <MobileIcon name="plus" className="w-5 h-5" />
              </span>
              <span className="m2-rule-copy">
                <strong>管理自定义规则</strong>
                <small>用正则和目录模板描述文件名结构</small>
              </span>
            </button>
          </div>
        ) : (
          <>
            <div className="m2-summary tabular-nums">
              <div>
                <b>{groups.length}</b>
                <small>新目录</small>
              </div>
              <div>
                <b>{moving}</b>
                <small>移动图片</small>
              </div>
              <div>
                <b>{staying}</b>
                <small>保持原位</small>
              </div>
            </div>
            {groups.slice(0, GROUP_RENDER_LIMIT).map((g) => (
              <section key={g.dir} className="m2-group">
                <div className="m2-group-head">
                  <MobileIcon name="folder" className="w-[18px] h-[18px] shrink-0" />
                  <strong className="truncate">{g.dir}</strong>
                  <small className="tabular-nums">{g.bindings.length} 张</small>
                  <button className="m2-icon-button is-small" onClick={() => setRenaming(g.dir)} aria-label={`重命名目录 ${g.dir}`}>
                    <MobileIcon name="edit" className="w-4 h-4" />
                  </button>
                </div>
                <div className="m2-group-thumbs">
                  {g.bindings.slice(0, GROUP_THUMBS).map((b) => (
                    <div key={b.imageId}>{thumb(imageById.get(b.imageId))}</div>
                  ))}
                  {g.bindings.length > GROUP_THUMBS && <div className="is-more tabular-nums">+{g.bindings.length - GROUP_THUMBS}</div>}
                </div>
                <div className="m2-group-files">
                  {g.bindings.slice(0, 2).map((b) => (
                    <div key={b.imageId}>
                      {imageById.get(b.imageId)?.name} → <b>{b.virtualPath}</b>
                    </div>
                  ))}
                </div>
              </section>
            ))}
            {groups.length > GROUP_RENDER_LIMIT && <p className="m2-empty-line">还有 {groups.length - GROUP_RENDER_LIMIT} 个目录未展开显示。</p>}
            {stayingImages.length > 0 && (
              <section className="m2-group is-muted">
                <div className="m2-group-head">
                  <MobileIcon name="eye-off" className="w-[18px] h-[18px] shrink-0" />
                  <strong>保持原位（未匹配或置信度低）</strong>
                  <small className="tabular-nums">{stayingImages.length} 张</small>
                </div>
                <div className="m2-group-thumbs">
                  {stayingImages.slice(0, GROUP_THUMBS).map((img) => (
                    <div key={img.id}>{thumb(img)}</div>
                  ))}
                  {stayingImages.length > GROUP_THUMBS && <div className="is-more tabular-nums">+{stayingImages.length - GROUP_THUMBS}</div>}
                </div>
              </section>
            )}
          </>
        )}
        <div className="h-28" aria-hidden="true" />
      </main>

      <div className="m2-bottom-cta" style={{ paddingBottom: 'calc(env(safe-area-inset-bottom, 0px) + 14px)' }}>
        {step === 1 ? (
          <button className="m2-button is-primary" disabled={rule.hitCount === 0} onClick={() => onStepChange(2)}>
            生成预览
            <MobileIcon name="chevron-right" className="w-[18px] h-[18px]" />
          </button>
        ) : (
          <>
            <button className="m2-button is-secondary" onClick={() => onStepChange(1)}>
              上一步
            </button>
            <button className="m2-button is-primary" disabled={moving === 0} onClick={() => onApply(groups.flatMap((g) => g.bindings), rule.name)}>
              <MobileIcon name="check" className="w-[18px] h-[18px]" />
              确认整理
            </button>
          </>
        )}
      </div>

      {renaming != null && (
        <MobilePromptDialog
          title="重命名目录"
          label="目录名（可用 / 表示多级）"
          initialValue={renaming}
          confirmLabel="保存"
          onSubmit={(value) => {
            setEdited({ ruleId, bindings: renameGroup(bindings, renaming, value) });
            setRenaming(null);
          }}
          onCancel={() => setRenaming(null)}
        />
      )}
    </div>
  );
}
