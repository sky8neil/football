import { AdminRole, AdminStatus } from "../domain/enums.js";
import { conflictError, internalError } from "../domain/errors.js";
import type { Admin } from "../domain/types.js";
import type { UnitOfWork } from "../infrastructure/repositories.js";

/**
 * 管理员身份只接受可信微信上下文中的 openid。请求 body 中的 admin_id 不参与授权。
 */
export class AdminAuthorizationService {
  async requireActiveAdmin(
    tx: UnitOfWork,
    trustedOpenid: string | null | undefined,
  ): Promise<Admin> {
    if (typeof trustedOpenid !== "string" || trustedOpenid.trim().length === 0) {
      throw conflictError("AUTH_REQUIRED", "需要可信管理员身份");
    }
    if (tx.admins === undefined) {
      throw internalError("管理员 repository port 未配置");
    }

    const admin = await tx.admins.findByOpenid(trustedOpenid);
    if (
      admin === null ||
      admin.status !== AdminStatus.Active ||
      admin.role !== AdminRole.Admin
    ) {
      throw conflictError("FORBIDDEN", "当前身份不是 active 管理员");
    }
    return admin;
  }
}
