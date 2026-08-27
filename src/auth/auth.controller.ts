import { Controller, Post, Body, Get, Patch, Delete, Param, UseGuards, Req } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { AuthRateGuard } from '../members/auth-rate.guard';
import { Throttle } from '@nestjs/throttler';
import { AuthService } from './auth.service';
import { CreateUserDto } from './dto/create-user.dto';
import { LoginDto } from './dto/login.dto';
import { UpdateUserRoleDto } from './dto/update-user-role.dto';
import { ResetPasswordDto } from './dto/reset-password.dto';
import { JwtAuthGuard } from './jwt-auth.guard';
import { RolesGuard } from './roles.guard';
import { Roles } from './roles.decorator';

import { StudentRegisterDto } from './dto/student-register.dto';
import { UpdateStudentIdDto } from './dto/update-student-id.dto';

@Controller(['api/v1/auth', 'api/v1/staff-auth'])
@ApiTags('认证')
export class AuthController {
  constructor(private authService: AuthService) {}

  @Throttle({ default: { limit: 200, ttl: 60000 } })
  @Post('student-register')
  @ApiOperation({ summary: '普通用户自主注册并绑定学号' })
  async registerStudent(@Body() dto: StudentRegisterDto) {
    return this.authService.registerStudent(dto);
  }

  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('super_admin')
  @Post('register')
  @ApiOperation({ summary: '后台创建用户账号（仅超级管理员）' })
  async register(@Body() createUserDto: CreateUserDto) {
    return this.authService.register(createUserDto);
  }

  @Throttle({ default: { limit: 200, ttl: 60000 } })
  @UseGuards(AuthRateGuard)
  @Post('login')
  @ApiOperation({ summary: '用户登录' })
  async login(@Body() loginDto: LoginDto) {
    return this.authService.login(loginDto);
  }

  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  @Get('me')
  @ApiOperation({ summary: '获取当前登录用户信息' })
  async getCurrentUser(@Req() req: any) {
    return req.user;
  }

  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('super_admin')
  @Get('users')
  @ApiOperation({ summary: '获取所有用户列表（仅超级管理员）' })
  async getUsers() {
    return this.authService.getAllUsers();
  }

  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('super_admin')
  @Patch('users/:id/role')
  @ApiOperation({ summary: '修改用户角色和绑定球队（仅超级管理员）' })
  async updateRole(
    @Param('id') id: string,
    @Body() updateUserRoleDto: UpdateUserRoleDto,
    @Req() req: any,
  ) {
    const operatorUsername = req.user?.username || 'admin';
    const operatorId = req.user?.id;
    return this.authService.updateUserRole(
      id,
      updateUserRoleDto.role,
      updateUserRoleDto.teamId,
      operatorUsername,
      operatorId,
    );
  }

  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('super_admin')
  @Delete('users/:id')
  @ApiOperation({ summary: '删除用户账号（仅超级管理员）' })
  async deleteUser(@Param('id') id: string, @Req() req: any) {
    const operatorUsername = req.user?.username || 'admin';
    const operatorId = req.user?.id;
    return this.authService.deleteUser(id, operatorUsername, operatorId);
  }

  @Throttle({ default: { limit: 5, ttl: 60000 } })
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('super_admin')
  @Patch('users/:id/reset-password')
  @ApiOperation({ summary: '重置用户密码（仅超级管理员）' })
  async resetPassword(
    @Param('id') id: string,
    @Body() resetPasswordDto: ResetPasswordDto,
    @Req() req: any,
  ) {
    const operatorUsername = req.user?.username || 'admin';
    return this.authService.resetPassword(id, resetPasswordDto.password, operatorUsername);
  }

  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('super_admin')
  @Patch('users/:id/student-id')
  @ApiOperation({ summary: '修改用户绑定学号（仅超级管理员）' })
  async updateStudentId(@Param('id') id: string, @Body() dto: UpdateStudentIdDto, @Req() req: any) {
    const operatorUsername = req.user?.username || 'admin';
    return this.authService.updateUserStudentId(id, dto.studentId, operatorUsername);
  }
}
