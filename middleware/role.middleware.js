// Role ids come from the `role` table (matches s_user.user_role_type_id).
const ROLES = {
  SPOC: 1,
  CSR: 2,
  LEAD_CONSULTANT: 4,
  ADMIN: 5,
  TEAM_LEAD: 26,
};

// Must run after `authenticate` (needs req.user). Any other role gets 403.
const requireRole = (...allowedRoleIds) => (req, res, next) => {
  const roleId = Number(req.user?.user_role_type_id);

  if (!allowedRoleIds.includes(roleId)) {
    return res.status(403).json({
      success: false,
      error: "FORBIDDEN",
      message: "You do not have permission to access this resource",
    });
  }

  next();
};

module.exports = { ROLES, requireRole };
