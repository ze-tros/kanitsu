/**
 * 桌面智能整理对话框：① 选择规则（命中数 + 示例映射）→ ② 预览分组（可改名）→ 确认。
 * 确认前不移动任何文件；落盘由 LibraryBrowser 以任务形式执行，完成后可撤销。
 * 规则解析与分组复用 organizePlan（与移动端同一份逻辑）。
 * 默认只整理图包的直属图片；图包没有直属图片时默认包含子目录，可在第一步切换。
 */
import { useEffect, useMemo, useState } from 'react';
import {
  ArrowRight,
  BracketsCurly,
  CalendarBlank,
  CaretLeft,
  CaretRight,
  Check,
  Folder,
  Hash,
  ImageSquare,
  Images,
  MagicWand,
  PencilSimple,
  ShieldCheck,
  Stack,
  Tag,
  ArrowCounterClockwise,
  X,
} from '@phosphor-icons/react';
import { directImagesOf, imagesOf, type FolderNode, type ImageEntry, type LibrarySnapshot, type OrganizeBinding } from '../../../core/src/index';
import type { LibraryStore } from '../../../fs-adapter/src/types';
import type { CustomOrganizeRule } from '../../../organizer/src/index';
import { BlobImage } from '../BlobImage';
import {
  AUTO_RULE_ID,
  bindingsForRule,
  defaultRuleId,
  planBindings,
  planConflicts,
  previewGroups,
  renameGroup,
  ruleOptions,
  type PlannedBinding,
} from '../organizePlan';
import { formatCount, imageFileRef, ILLEGAL_NAME } from './shared';
import { Switch } from './controls';
import { DialogFrame } from './Dialogs';
import { EmptyState } from './pageParts';

const RULE_ICONS: Record<string, typeof Folder> = {
  [AUTO_RULE_ID]: MagicWand,
  separator: Folder,
  date: CalendarBlank,
  author: Tag,
  chapter: Stack,
  pixiv: Images,
  commonPrefix: Hash,
};

/** 示例映射：每个分组取前几张，避免全落在第一个分组里。 */
const SAMPLE_PER_GROUP = 2;
const SAMPLE_LIMIT = 12;
const GROUP_THUMB_LIMIT = 80;
const REST_KEY = '__rest__';

/** 默认整理范围：有直属图片时只整理直属图片，否则包含子目录。检查器的整理提示按同一口径计算。 */
export function organizeIncludesSubfoldersByDefault(folder: FolderNode): boolean {
  return folder.directImageCount === 0;
}

export function OrganizeDialog({
  folder,
  snapshot,
  customRules,
  store,
  blurredImages,
  initialRuleId,
  onApply,
  onClose,
  onManageRules,
}: {
  folder: FolderNode;
  snapshot: LibrarySnapshot;
  customRules: CustomOrganizeRule[];
  store: LibraryStore;
  blurredImages: ReadonlySet<string>;
  initialRuleId?: string;
  onApply: (bindings: OrganizeBinding[], ruleName: string) => void;
  onClose: () => void;
  onManageRules: () => void;
}) {
  const hasSubfolderImages = folder.imageCount > folder.directImageCount;
  const [includeSubfolders, setIncludeSubfolders] = useState(() => organizeIncludesSubfoldersByDefault(folder));
  const images = useMemo(
    () => (includeSubfolders ? imagesOf(snapshot, folder.id) : directImagesOf(snapshot, folder.id)),
    [folder.id, includeSubfolders, snapshot],
  );
  const planned = useMemo(() => planBindings(images, customRules), [images, customRules]);
  const options = useMemo(() => ruleOptions(planned, customRules), [planned, customRules]);
  const [step, setStep] = useState<1 | 2>(1);
  // 用户点选过的规则（或检查器提示带来的规则）优先；否则跟随范围取命中最多的规则。
  const [pickedRuleId, setPickedRuleId] = useState<string | null>(initialRuleId ?? null);
  const ruleId = pickedRuleId && options.some((o) => o.id === pickedRuleId) ? pickedRuleId : defaultRuleId(options);
  const [edited, setEdited] = useState<{ ruleId: string; bindings: PlannedBinding[] } | null>(null);
  const [activeGroup, setActiveGroup] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<{ dir: string; value: string } | null>(null);

  const rule = options.find((o) => o.id === ruleId) ?? options[0]!;
  const selected = useMemo(() => bindingsForRule(planned, ruleId), [planned, ruleId]);
  const bindings = edited && edited.ruleId === ruleId ? edited.bindings : selected;
  const groups = useMemo(() => previewGroups(bindings), [bindings]);
  const moving = groups.reduce((sum, g) => sum + g.bindings.length, 0);
  const imageById = useMemo(() => new Map(images.map((image) => [image.id, image])), [images]);
  const stayingImages = useMemo(() => {
    const moved = new Set(groups.flatMap((g) => g.bindings.map((b) => b.imageId)));
    return images.filter((image) => !moved.has(image.id));
  }, [groups, images]);
  const folderIdByRel = useMemo(() => {
    const map = new Map<string, string>();
    for (const node of Object.values(snapshot.folders)) map.set(node.relPath, node.id);
    return map;
  }, [snapshot]);
  const conflicts = useMemo(
    () =>
      planConflicts(
        groups,
        (dir) => {
          const id = folderIdByRel.get(folder.relPath ? `${folder.relPath}/${dir}` : dir);
          return id ? { names: new Set(directImagesOf(snapshot, id).map((image) => image.name)) } : undefined;
        },
        (imageId) => snapshot.images[imageId]?.relPath,
        folder.relPath,
      ),
    [folder.relPath, folderIdByRel, groups, snapshot],
  );
  const samples = useMemo(
    () => groups.flatMap((g) => g.bindings.slice(0, SAMPLE_PER_GROUP)).slice(0, SAMPLE_LIMIT),
    [groups],
  );

  useEffect(() => {
    if (step === 2 && (!activeGroup || (activeGroup !== REST_KEY && !groups.some((g) => g.dir === activeGroup)))) {
      setActiveGroup(groups[0]?.dir ?? (stayingImages.length ? REST_KEY : null));
    }
  }, [activeGroup, groups, stayingImages.length, step]);

  const commitRename = () => {
    if (!renaming) return;
    const value = renaming.value.trim();
    // 目录名允许用 / 表示层级，其余非法字符按段检查。
    if (value && !value.split('/').some((seg) => ILLEGAL_NAME.test(seg))) {
      const next = renameGroup(bindings, renaming.dir, value);
      setEdited({ ruleId, bindings: next });
      setActiveGroup(value);
    }
    setRenaming(null);
  };

  const thumb = (image: ImageEntry | undefined) =>
    image ? <BlobImage store={store} fileRef={imageFileRef(image)} alt="" className="dk-art" thumbnail lazy blur={blurredImages.has(image.relPath)} /> : null;

  const steps = (
    <div className="dk-steps" aria-label={`第 ${step} 步，共 2 步`}>
      <b className={step === 1 ? 'on' : 'done'}><i>{step === 1 ? '1' : <Check size={11} weight="bold" />}</i>选择规则</b>
      <CaretRight size={11} />
      <b className={step === 2 ? 'on' : ''}><i>2</i>预览分组</b>
      <CaretRight size={11} />
      <b><i>3</i>确认落盘</b>
    </div>
  );

  const summary = (
    <div className="dk-org-sum">
      <span><b className="num">{formatCount(groups.length - conflicts.mergeDirs.size)}</b>个新子图包</span>
      {conflicts.mergeDirs.size > 0 && <span><b className="num">{formatCount(conflicts.mergeDirs.size)}</b>个并入已有子图包</span>}
      <span><b className="num">{formatCount(moving - conflicts.conflictIds.size)}</b>张将被移动</span>
      <span><b className="num">{formatCount(images.length - moving + conflicts.conflictIds.size)}</b>张保持原位</span>
      <span className={conflicts.conflictIds.size > 0 ? 'warn' : ''}><b className="num">{formatCount(conflicts.conflictIds.size)}</b>个冲突</span>
    </div>
  );

  const activeImages: ImageEntry[] =
    activeGroup === REST_KEY
      ? stayingImages
      : (groups.find((g) => g.dir === activeGroup)?.bindings ?? []).map((b) => imageById.get(b.imageId)).filter((img): img is ImageEntry => Boolean(img));
  const activeTitle = activeGroup === REST_KEY ? '保持原位' : activeGroup ?? '';
  const activeConflictCount = activeGroup === REST_KEY ? 0 : activeImages.filter((image) => conflicts.conflictIds.has(image.id)).length;

  return (
    <DialogFrame
      label={`智能整理「${folder.name}」`}
      className="dk-org"
      onClose={onClose}
      onEscape={renaming ? () => setRenaming(null) : onClose}
    >
        <div className="dk-dlg-h">
          <div>
            <h2>智能整理「{folder.name}」</h2>
            {steps}
          </div>
          <button type="button" className="dk-ib" aria-label="关闭" onClick={onClose}><X size={16} /></button>
        </div>

        {step === 1 ? (
          <div className="dk-org-body">
            <div className="dk-org-l dk-scroll" role="radiogroup" aria-label="整理规则">
              {options.map((option) => {
                const Icon = RULE_ICONS[option.id] ?? BracketsCurly;
                return (
                  <button
                    key={`${option.kind}-${option.id}`}
                    type="button"
                    role="radio"
                    aria-checked={option.id === ruleId}
                    className={`dk-rule ${option.id === ruleId ? 'on' : ''} ${option.hitCount === 0 ? 'zero' : ''}`}
                    onClick={() => {
                      setPickedRuleId(option.id);
                      setEdited(null);
                    }}
                  >
                    <span className="dk-ri"><Icon size={17} /></span>
                    <span className="dk-shrink">
                      <b>{option.name}</b>
                      <small>{option.description}</small>
                    </span>
                    <span className="dk-hits"><b className="num">{formatCount(option.hitCount)}</b><br />命中</span>
                  </button>
                );
              })}
              <button type="button" className="dk-rule" onClick={onManageRules}>
                <span className="dk-ri"><BracketsCurly size={17} /></span>
                <span><b>自定义规则…</b><small>用正则表达式编写自己的规则</small></span>
                <span />
              </button>
            </div>
            <div className="dk-org-r dk-scroll">
              {hasSubfolderImages && (
                <div className="dk-org-scope">
                  <span className="dk-shrink">
                    <b>包含子目录里的图片</b>
                    <small>
                      {includeSubfolders
                        ? `共 ${formatCount(folder.imageCount)} 张；子目录里命中的图片会移到新的子图包中`
                        : `只整理直属的 ${formatCount(folder.directImageCount)} 张，子目录保持不变`}
                    </small>
                  </span>
                  <Switch
                    checked={includeSubfolders}
                    label="包含子目录里的图片"
                    onChange={(value) => {
                      setIncludeSubfolders(value);
                      setEdited(null);
                    }}
                  />
                </div>
              )}
              {summary}
              <h4 className="dk-h4">示例映射</h4>
              {samples.length > 0 ? (
                samples.map((binding) => {
                  const image = imageById.get(binding.imageId);
                  const slash = binding.virtualPath.lastIndexOf('/');
                  return (
                    <div key={binding.imageId} className="dk-map-row">
                      <span className="dk-src" title={image?.relPath}>{image?.name ?? binding.imageId}</span>
                      <ArrowRight size={12} />
                      <span className="dk-dst" title={binding.virtualPath}>
                        <em>{slash >= 0 ? `${binding.virtualPath.slice(0, slash)}/` : ''}</em>
                        {slash >= 0 ? binding.virtualPath.slice(slash + 1) : binding.virtualPath}
                      </span>
                    </div>
                  );
                })
              ) : (
                <EmptyState
                  compact
                  title={images.length === 0 ? '这个图包没有直属图片可以整理' : '这条规则没有命中'}
                  text={images.length === 0 ? '打开「包含子目录里的图片」后再试。' : '换一条规则试试，或者编写自定义规则。'}
                />
              )}
            </div>
          </div>
        ) : (
          <div className="dk-org-body">
            <div className="dk-org-l dk-scroll" role="listbox" aria-label="预览分组">
              {groups.map((group) => {
                const first = imageById.get(group.bindings[0]?.imageId ?? '');
                const editing = renaming?.dir === group.dir;
                return (
                  <div
                    key={group.dir}
                    role="option"
                    aria-selected={activeGroup === group.dir}
                    className={`dk-grp ${activeGroup === group.dir ? 'on' : ''}`}
                    onClick={() => !renaming && setActiveGroup(group.dir)}
                  >
                    <span className="dk-gi">{thumb(first)}</span>
                    <span className="dk-gn">
                      {editing ? (
                        <input
                          autoFocus
                          value={renaming.value}
                          aria-label="目录名"
                          onChange={(event) => setRenaming({ dir: group.dir, value: event.target.value })}
                          onBlur={commitRename}
                          onKeyDown={(event) => {
                            if (event.key === 'Enter') commitRename();
                            if (event.key === 'Escape') {
                              event.stopPropagation();
                              setRenaming(null);
                            }
                          }}
                        />
                      ) : (
                        <b title={group.dir}>{group.dir}</b>
                      )}
                      <small className="num">
                        {formatCount(group.bindings.length)} 张
                        {conflicts.mergeDirs.has(group.dir) && <span className="warn"> · 同名子图包已存在，将合并</span>}
                      </small>
                    </span>
                    {!editing && (
                      <button
                        type="button"
                        className="dk-ib"
                        title="改名"
                        aria-label={`重命名目录${group.dir}`}
                        onClick={(event) => {
                          event.stopPropagation();
                          setRenaming({ dir: group.dir, value: group.dir });
                        }}
                      >
                        <PencilSimple size={13} />
                      </button>
                    )}
                  </div>
                );
              })}
              {stayingImages.length > 0 && (
                <div role="option" aria-selected={activeGroup === REST_KEY} className={`dk-grp ${activeGroup === REST_KEY ? 'on' : ''}`} onClick={() => setActiveGroup(REST_KEY)}>
                  <span className="dk-gi"><ImageSquare size={16} /></span>
                  <span className="dk-gn"><b>保持原位</b><small className="num">{formatCount(stayingImages.length)} 张未命中规则</small></span>
                </div>
              )}
            </div>
            <div className="dk-org-r dk-scroll">
              {summary}
              <h4 className="dk-h4 dk-grp-title">
                {activeTitle} <small>· {formatCount(activeImages.length)} 张</small>
              </h4>
              {activeConflictCount > 0 && (
                <p className="dk-tip warn">其中 {formatCount(activeConflictCount)} 张与目标位置的文件同名，确认后会跳过、留在原位。</p>
              )}
              <div className="dk-org-grid">
                {activeImages.slice(0, GROUP_THUMB_LIMIT).map((image) => (
                  <div key={image.id} className="dk-c">
                    {thumb(image)}
                    <small>{image.name}</small>
                  </div>
                ))}
              </div>
              {activeImages.length > GROUP_THUMB_LIMIT && (
                <p className="dk-tip dk-org-more">另有 {formatCount(activeImages.length - GROUP_THUMB_LIMIT)} 张未列出。</p>
              )}
            </div>
          </div>
        )}

        <div className="dk-dlg-f ruled">
          {step === 1 ? (
            <>
              <span className="dk-note"><ShieldCheck size={13} />这一步只解析文件名，不会移动任何文件。</span>
              <button type="button" className="dk-btn ghost" onClick={onClose}>取消</button>
              <button type="button" className="dk-btn primary" disabled={groups.length === 0} onClick={() => setStep(2)}>
                生成预览<ArrowRight size={15} />
              </button>
            </>
          ) : (
            <>
              <span className="dk-note"><ArrowCounterClockwise size={13} />确认后可在任务中心撤销这次整理。</span>
              <button type="button" className="dk-btn ghost" onClick={() => setStep(1)}><CaretLeft size={15} />上一步</button>
              <button type="button" className="dk-btn primary" disabled={moving === 0} onClick={() => onApply(bindings, rule.name)}>
                确认整理 {formatCount(moving)} 张
              </button>
            </>
          )}
        </div>
    </DialogFrame>
  );
}
