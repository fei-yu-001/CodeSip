import os

# 1. Format Maogai
with open('maogai_parsed.md', 'r', encoding='utf-8') as f:
    raw = f.read()

lines = raw.split('\n')
cleaned = []
for l in lines:
    l_strip = l.strip()
    if l_strip and len(cleaned) > 0 and cleaned[-1].strip() == l_strip:
        continue
    cleaned.append(l)

clean_md = '\n'.join(cleaned)
# Remove raw blockquotes that duplicate normal text
clean_md = clean_md.replace('> 本文基于北邮近两年毛概期末真题', '本文基于近两年期末真题')

maogai_header = """---
title: 毛泽东思想和中国特色社会主义理论体系概论 · 期末考点速记手册
date: 2026-06-15
category: 政治理论
tags: [毛概, 期末复习, 背诵手册, 核心考点]
summary: 闭卷背诵导向手册：题型分值策略、高频考点分布、核心考点、简答题要点、论述题模板与时间线速记表。
---

# 毛泽东思想和中国特色社会主义理论体系概论 · 期末考点速记

> [!NOTE] 备考核心策略
> 闭卷背诵导向：先看 **🎯 老师最后一课划重点**，再看 **§一 真题考点分布**，按章节重点背诵；考前突击只看 **§时间线速记表** 即可。
> 提示：本课程不含“习近平新时代中国特色社会主义思想”（为单独课程），内容截止于科学发展观。

"""
maogai_content = maogai_header + clean_md

# Ensure directories exist
os.makedirs('vault_export/政治理论', exist_ok=True)
os.makedirs('vault_export/Java后端', exist_ok=True)

with open('vault_export/政治理论/毛泽东思想和中国特色社会主义理论体系概论-期末考点速记.md', 'w', encoding='utf-8') as f:
    f.write(maogai_content)

print('Generated Maogai note, size:', len(maogai_content))

# 2. Format Spring Boot Note
springboot_content = """---
title: Spring Boot 核心入门：@RestController 与 Web 控制器注解全解
date: 2026-11-23
category: Java后端
tags: [SpringBoot, Java, Web开发, 核心注解, 学习笔记]
summary: 深度剖析 Spring Boot Web 控制器架构、@RestController 组合原理、@RequestMapping 映射机制与 HTTP 响应生命周期。
---

# Spring Boot 核心入门：@RestController 与 Web 控制器注解全解

> [!NOTE] 核心知识概览
> 控制器（Controller）是 Spring MVC 与 Spring Boot 构建 Web 应用的核心桥梁。它负责接收 HTTP 请求、调用业务逻辑、并向客户端返回数据。

---

## 一、 控制器源码还原与架构剖析

我们在实战中编写的第一个经典控制器代码如下：

```java
package controller;

import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

@RestController
public class helloController {

    @RequestMapping("/hello")
    public String hello() {
        System.out.println("hello");
        return "hello";
    }
}
```

### 1. 逐行核心机制剖析

| 代码行 | 核心语法 / 标识符 | 底层工作机制与关键细节 |
| --- | --- | --- |
| `package controller;` | 包声明 | 定义该控制器所在的包空间。在 Spring Boot 中，默认以主启动类所在的包及其子包为组件扫描基准。若包路径偏离，需显式声明 `@ComponentScan`。 |
| `@RestController` | 组合注解 | **核心注解**：等价于 `@Controller` + `@ResponseBody` 的复合体。声明当前类为 Spring IoC 容器纳管的控制器 Bean，且所有处理方法的返回值直接作为 HTTP 响应体。 |
| `public class helloController` | 类定义 | 推荐规范遵循大驼峰命名（如 `HelloController`）。Spring 容器初始化时，会自动将该类实例化为一个名为 `helloController` 的单例 Bean 注入容器。 |
| `@RequestMapping("/hello")` | 路由映射注解 | 将 HTTP 请求路径 `/hello` 绑定到下方的方法 `hello()` 上。默认支持所有 HTTP Method（GET、POST、PUT、DELETE 等）。 |
| `System.out.println("hello");` | 控制台标准输出 | **服务端本地输出**：在服务器终端/日志打印字符，用于服务端开发者调试追踪执行轨迹，不属于 HTTP 响应内容。 |
| `return "hello";` | 方法返回值 | **HTTP 响应体返回**：由 `HttpMessageConverter` 转换为响应数据流，写入 HTTP Response Body 并返回给浏览器/客户端。 |

---

## 二、 核心注解深度解构：为什么用 @RestController？

在传统 Spring MVC 与现代前后端分离开发中，两个注解的对比极为经典：

### 2.1 @RestController 的本质

`@RestController` 并不是底层孤立的单一注解，它是一个**元注解复合体**：

```java
@Target(ElementType.TYPE)
@Retention(RetentionPolicy.RUNTIME)
@Documented
@Controller
@ResponseBody
public @interface RestController {
    @AliasFor(annotation = Controller.class)
    String value() default "";
}
```

- **`@Controller`**：告诉 Spring 容器，这个类是一个 Web 控制器组件，注册到 Spring IoC 容器。
- **`@ResponseBody`**：指示方法返回的值**不会被解析为视图名称（View Name）**，而是直接通过配置的转换器（如 `StringHttpMessageConverter` 或 `MappingJackson2HttpMessageConverter`）直接写入 HTTP 响应体。

### 2.2 @Controller 与 @RestController 对比

| 维度 | @Controller | @RestController |
| --- | --- | --- |
| 主要应用场景 | 传统服务端模板渲染（JSP、Thymeleaf、Freemarker） | 现代前后端分离、RESTful Web API、微服务数据接口 |
| 返回值含义 | 默认为**页面视图路径**（如返回 `"index"` 会找 `index.html`） | 直接作为 **HTTP 响应体内容**（字符串、JSON、XML） |
| 返回对象行为 | 若需返回 JSON，必须在类或方法上额外加 `@ResponseBody` | 自动序列化返回对象为 JSON 或指定媒体类型数据 |

---

## 三、 HTTP 请求生命周期与调度时序

当用户在浏览器访问 `http://localhost:8080/hello` 时，Spring Boot 底层的真实处理时序如下：

```text
客户端/浏览器 (GET /hello)
       │
       ▼
 嵌入式 Tomcat (监听端口 8080)
       │
       ▼
 DispatcherServlet (核心前端控制器，调度中心)
       │
       ├─► 1. HandlerMapping: 查找与 URL "/hello" 匹配的处理器
       │     └─ 查找到: helloController.hello()
       │
       ├─► 2. HandlerAdapter: 执行具体的控制器方法
       │     └─ 执行 System.out.println("hello") [服务端控制台输出]
       │     └─ 得到返回值 "hello"
       │
       ├─► 3. HttpMessageConverter: 响应内容格式转换
       │     └─ 字符串直接写出为 text/plain;charset=UTF-8
       │
       ▼
 HTTP 200 OK 响应体: "hello" 返回客户端
```

---

## 四、 从 @RequestMapping 到 RESTful 专属注解

虽然 `@RequestMapping("/hello")` 功能通用，但在现代化开发中，推荐使用语义更明确的派生注解：

| 专属注解 | 等价写法 | 适用 HTTP 动词 | 典型业务场景 |
| --- | --- | --- | --- |
| `@GetMapping` | `@RequestMapping(method = RequestMethod.GET)` | GET | 查询数据、读取资源 |
| `@PostMapping` | `@RequestMapping(method = RequestMethod.POST)` | POST | 提交表单、创建新资源 |
| `@PutMapping` | `@RequestMapping(method = RequestMethod.PUT)` | PUT | 完整更新已有资源 |
| `@DeleteMapping` | `@RequestMapping(method = RequestMethod.DELETE)` | DELETE | 删除指定资源 |
| `@PatchMapping` | `@RequestMapping(method = RequestMethod.PATCH)` | PATCH | 局部增量修改资源 |

### 改进后更加优雅的规范写法：

```java
package online.ddyu.controller;

import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

@RestController
@RequestMapping("/api/v1")
public class HelloController {

    @GetMapping("/hello")
    public String sayHello() {
        return "Hello, CodeSip!";
    }
}
```

---

## 五、 高频踩坑点与工程规范备忘

1. **404 Not Found：包扫描路径脱节**
   - 现象：启动无报错，但访问 `localhost:8080/hello` 报 404。
   - 原因：控制器所在的包（如 `controller`）没有在主启动类（带 `@SpringBootApplication`）的同级或子包目录下。
   - 解决：保证启动类位于根包（如 `com.example`），控制器位于其子包（如 `com.example.controller`）。

2. **返回中文乱码**
   - 现象：返回中文内容在某些老旧客户端上显示为问号。
   - 原因：早期的字符集转换器未显式设定 UTF-8。
   - 解决：现代 Spring Boot 3.x 默认 UTF-8；或显式声明 `@GetMapping(value = "/hello", produces = "text/plain;charset=UTF-8")`。

3. **类命名规范**
   - Java 官方驼峰规范：类名首字母应大写为 `HelloController`，方法名小写 `hello()`。
"""

with open('vault_export/Java后端/SpringBoot核心入门与Web控制器注解精讲.md', 'w', encoding='utf-8') as f:
    f.write(springboot_content)

print('Generated SpringBoot note, size:', len(springboot_content))
