const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

const blockedUserMessages = {
  MANIFEST_MISMATCH: {
    message: '制品身份未通过核对，请重新生成并发布。',
    nextAction: 'rebuild_and_publish',
  },
  NO_VERIFIED_PREVIOUS_ARTIFACT: {
    message: '检查未通过，当前没有可恢复的上一版本。',
    nextAction: 'fix_checks_and_publish_again',
  },
};

export const userRetryResult = () => ({
  status: 'needs_attention',
  label: '需要处理',
  message: '发布状态暂时无法确认，请修正后重试。',
  actionRequired: true,
  nextAction: 'retry_release',
});

/** Converts an internal release decision into the small user-facing envelope. */
export const toUserFacingReleaseResult = (result) => {
  if (!isPlainObject(result) || !['ready', 'activate', 'rollback', 'blocked'].includes(result.decision)) {
    throw new Error('RELEASE_RESULT_INVALID');
  }
  if (result.decision === 'ready') {
    if (typeof result.version !== 'string' || result.version.trim() === '') throw new Error('RELEASE_RESULT_VERSION_REQUIRED');
    return {
      status: 'ready',
      label: '可发布',
      message: '版本已通过检查，可以发布。',
      version: result.version,
      actionRequired: true,
      nextAction: 'approve_release',
    };
  }
  if (result.decision === 'activate') {
    if (typeof result.version !== 'string' || result.version.trim() === '') throw new Error('RELEASE_RESULT_VERSION_REQUIRED');
    return {
      status: 'activated',
      label: '已激活',
      message: '版本已完成检查并启用。',
      version: result.version,
      actionRequired: false,
    };
  }
  if (result.decision === 'rollback') {
    const version = result.rollbackTo?.version;
    if (typeof version !== 'string' || version.trim() === '') throw new Error('RELEASE_RESULT_ROLLBACK_VERSION_REQUIRED');
    return {
      status: 'rolled_back',
      label: '已自动回滚',
      message: '新版本检查未通过，系统已恢复上一版本。',
      restoredVersion: version,
      actionRequired: false,
      nextAction: 'review_checks',
    };
  }
  const blocked = blockedUserMessages[result.reasonCode] || {
    message: '发布门禁未通过，请处理检查结果后重试。',
    nextAction: 'review_checks_and_publish_again',
  };
  return {
    status: 'needs_attention',
    label: '需要处理',
    message: blocked.message,
    actionRequired: true,
    nextAction: blocked.nextAction,
  };
};
