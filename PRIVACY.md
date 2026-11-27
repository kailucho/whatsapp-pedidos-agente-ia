# Política de privacidad — agente-pedidos-demo

Última actualización: 26 de noviembre de 2026.

`agente-pedidos-demo` es un proyecto personal de demostración (no un servicio comercial) que responde mensajes de WhatsApp mediante la WhatsApp Business Cloud API de Meta.

## Qué datos se tratan

- Número de WhatsApp y nombre de perfil de quien escribe al número de demostración.
- Texto de los mensajes enviados y de las respuestas del bot.
- Pedidos de prueba creados en la conversación (productos, cantidades y total).

## Para qué se usan

Únicamente para responder la conversación y demostrar el funcionamiento del agente. No se usan para publicidad, no se venden ni se comparten con terceros, salvo el envío de las respuestas a través de la API de Meta, necesario para que lleguen por WhatsApp.

## Dónde se guardan y por cuánto tiempo

En una base de datos local (SQLite) en el equipo del desarrollador, no en servidores de terceros. Los datos de prueba se eliminan periódicamente y como máximo a los 90 días.

## Quién puede escribir

Mientras la app esté en modo de prueba, solo los números autorizados explícitamente en la cuenta de desarrollador de Meta pueden recibir mensajes del bot.

## Tus derechos

Puedes pedir el acceso o la eliminación de tus datos abriendo un issue en este repositorio: https://github.com/kailucho/whatsapp-pedidos-agente-ia/issues. Se atiende en un plazo máximo de 30 días.
