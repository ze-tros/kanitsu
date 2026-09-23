# Kanitsu 定制的 NSIS 片段（electron-builder 约定路径 build/installer.nsh，自动 include）。
#
# 桌面快捷方式改为安装时的可选项，默认不创建：
# - build.nsis.createDesktopShortcut=false 让模板不再自动创建（安装/卸载两条路径都已关闭）；
# - 用模板钩子 customFinishPage 替换默认完成页：勾选「创建桌面快捷方式」才创建，
#   与「运行 Kanitsu」并排放在最后一屏；
# - customInstall 统一清掉旧版安装默认创建的桌面快捷方式（静默安装也覆盖），
#   完成页勾选时会重新创建；
# - 卸载时移除桌面快捷方式（customUnInstall；模板在 DO_NOT_CREATE 下不再负责删除）。
# 「开始菜单」快捷方式仍由模板默认创建。

!include "nsDialogs.nsh"

# 语言 ID 只能用数字：include 发生在脚本最顶部，此时 LANG_* 常量尚未定义。
# 1033 英文 / 2052 简体中文 / 1028 繁体中文；installerLanguages 已限定为这三种。
LangString kanitsuFinishTitle 1033 "Completing Kanitsu Setup"
LangString kanitsuFinishTitle 2052 "正在完成 Kanitsu 安装"
LangString kanitsuFinishTitle 1028 "正在完成 Kanitsu 安裝"
LangString kanitsuFinishSubtitle 1033 "Choose whether to create a desktop shortcut."
LangString kanitsuFinishSubtitle 2052 "选择是否创建桌面快捷方式。"
LangString kanitsuFinishSubtitle 1028 "選擇是否建立桌面捷徑。"
LangString kanitsuShortcutCheckbox 1033 "Create desktop shortcut"
LangString kanitsuShortcutCheckbox 2052 "创建桌面快捷方式"
LangString kanitsuShortcutCheckbox 1028 "建立桌面捷徑"
LangString kanitsuRunCheckbox 1033 "Run Kanitsu"
LangString kanitsuRunCheckbox 2052 "运行 Kanitsu"
LangString kanitsuRunCheckbox 1028 "執行 Kanitsu"

!macro customInstall
  # 旧版安装包会默认创建桌面快捷方式：这里统一清掉遗留项（静默安装也生效）；
  # 最终是否保留由完成页勾选决定，勾选时会在完成页重新创建。
  ${if} ${FileExists} "$newDesktopLink"
    Delete "$newDesktopLink"
  ${endIf}
!macroend

# 替换默认完成页（模板 assistedInstaller.nsh：定义了 customFinishPage 就不再生成
# MUI_PAGE_FINISH），把「运行」与「创建桌面快捷方式」并排放在最后一屏。
# 本宏展开于 MUI2.nsh 之后，页面函数因此可以使用 MUI_HEADER_TEXT；
# 函数与变量都定义在宏内，卸载器那遍编译（BUILD_UNINSTALLER）不会插入本宏，
# 也就不会出现“变量/函数未被引用”的 NSIS warning。
!macro customFinishPage
  Page custom KanitsuFinishPageCreate

  Var kanitsuRunCheckbox            # 「运行 Kanitsu」复选框句柄（默认勾选）
  Var kanitsuRunState
  Var kanitsuDesktopShortcutCheckbox # 「创建桌面快捷方式」复选框句柄（默认不勾选）
  Var kanitsuDesktopShortcutState

  Function KanitsuFinishPageCreate
    !insertmacro MUI_HEADER_TEXT "$(kanitsuFinishTitle)" "$(kanitsuFinishSubtitle)"
    nsDialogs::Create 1018
    Pop $0
    ${NSD_CreateCheckbox} 0 2u 100% 10u "$(kanitsuRunCheckbox)"
    Pop $kanitsuRunCheckbox
    ${NSD_SetState} $kanitsuRunCheckbox 1
    ${NSD_CreateCheckbox} 0 18u 100% 10u "$(kanitsuShortcutCheckbox)"
    Pop $kanitsuDesktopShortcutCheckbox
    ${NSD_SetState} $kanitsuDesktopShortcutCheckbox 0
    nsDialogs::Show

    # 走到这里说明用户点了「完成」。
    ${NSD_GetState} $kanitsuDesktopShortcutCheckbox $kanitsuDesktopShortcutState
    ${if} $kanitsuDesktopShortcutState == 1
      CreateShortCut "$newDesktopLink" "$appExe" "" "$appExe" 0 "" "" "${APP_DESCRIPTION}"
      ClearErrors
      WinShell::SetLnkAUMI "$newDesktopLink" "${APP_ID}"
    ${endIf}

    # 与模板默认完成页一致：经 StdUtils 以当前用户身份启动（升级场景带 --updated）。
    ${NSD_GetState} $kanitsuRunCheckbox $kanitsuRunState
    ${if} $kanitsuRunState == 1
      ${if} ${isUpdated}
        StrCpy $1 "--updated"
      ${else}
        StrCpy $1 ""
      ${endIf}
      ${StdUtils.ExecShellAsUser} $0 "$launchLink" "open" "$1"
    ${endIf}
  FunctionEnd
!macroend

# 卸载端没有勾选页：按注册表记录的快捷方式名移除桌面快捷方式。
!macro customUnInstall
  WinShell::UninstShortcut "$oldDesktopLink"
  Delete "$oldDesktopLink"
!macroend
